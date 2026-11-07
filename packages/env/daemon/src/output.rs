//! The single writer of stdout. Control frames (results, errors, pings, watch events) always go before bulk command
//! output, so a slow link delays output but never a cancel's result or a ping. Bulk output is bounded: readers of
//! commands without an output window wait while too much of it is unsent, which slows the command down like a full
//! pipe would.

use crate::frame::{self, Frame};
use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Unsent bulk bytes above which unwindowed command output waits.
const BULK_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Queues {
    control: VecDeque<Frame>,
    bulk: VecDeque<(Frame, Option<Arc<AtomicUsize>>)>,
    bulk_bytes: usize,
    /// When the unsent bulk output last fell back to the limit, which lets waiting readers read again.
    released_at: Option<Instant>,
    closed: bool,
}

#[derive(Default)]
pub struct Output {
    queues: Mutex<Queues>,
    /// Signalled when a frame is queued or the writer stops.
    queued: Condvar,
    /// Signalled when bulk bytes were written.
    drained: Condvar,
}

impl Output {
    pub fn control(&self, frame: Frame) {
        let mut queues = self.queues.lock().unwrap();
        queues.control.push_back(frame);
        self.queued.notify_one();
    }

    /// Queue bulk output; `unsent` counts this sender's frames until they are written.
    pub fn bulk(&self, frame: Frame, unsent: Option<Arc<AtomicUsize>>) {
        let mut queues = self.queues.lock().unwrap();
        queues.bulk_bytes += frame.payload.len();
        if let Some(counter) = &unsent {
            counter.fetch_add(1, Ordering::SeqCst);
        }
        queues.bulk.push_back((frame, unsent));
        self.queued.notify_one();
    }

    /// Wait while more than the bulk limit is unsent, unless `stop` is set.
    pub fn wait_for_room(&self, stop: &AtomicBool) {
        let mut queues = self.queues.lock().unwrap();
        while queues.bulk_bytes > BULK_LIMIT && !queues.closed && !stop.load(Ordering::SeqCst) {
            queues = self
                .drained
                .wait_timeout(queues, Duration::from_millis(100))
                .unwrap()
                .0;
        }
    }

    /// Whether a reader may still be held back by this link: more than the bulk limit is unsent, or the link made room
    /// less than `grace` ago. A command's grace after its exit counts silence of its pipes, which a held-back reader
    /// does not read.
    pub fn holds_readers(&self, grace: Duration) -> bool {
        let queues = self.queues.lock().unwrap();
        !queues.closed
            && (queues.bulk_bytes > BULK_LIMIT
                || queues.released_at.is_some_and(|at| at.elapsed() < grace))
    }

    pub fn close(&self) {
        let mut queues = self.queues.lock().unwrap();
        queues.closed = true;
        self.queued.notify_all();
        self.drained.notify_all();
    }

    /// Write frames to `writer` until closed or a write fails.
    pub fn run(&self, writer: &mut impl Write) {
        loop {
            let (frame, unsent) = {
                let mut queues = self.queues.lock().unwrap();
                loop {
                    if let Some(frame) = queues.control.pop_front() {
                        break (frame, None);
                    }
                    if let Some((frame, unsent)) = queues.bulk.pop_front() {
                        let held = queues.bulk_bytes > BULK_LIMIT;
                        queues.bulk_bytes -= frame.payload.len();
                        if held && queues.bulk_bytes <= BULK_LIMIT {
                            queues.released_at = Some(Instant::now());
                        }
                        break (frame, unsent);
                    }
                    if queues.closed {
                        return;
                    }
                    queues = self.queued.wait(queues).unwrap();
                }
            };
            let failed = frame::write_frame(writer, &frame).is_err();
            if let Some(counter) = unsent {
                counter.fetch_sub(1, Ordering::SeqCst);
            }
            self.drained.notify_all();
            if failed {
                self.close();
                return;
            }
        }
    }
}
