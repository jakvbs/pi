import { branchLedger } from "./ledger.ts";
import {
	OM_OBSERVATIONS_DROPPED,
	OM_OBSERVATIONS_RECORDED,
	OM_REFLECTIONS_RECORDED,
	type Entry,
	type Observation,
	type Reflection,
} from "./types.ts";

export type FoldedLedger = {
	/** All first-valid observation records encountered through the fold boundary, including dropped observations. */
	observations: Observation[];
	/** Observation records not tombstoned by a folded drop entry. */
	activeObservations: Observation[];
	/** Tombstoned observation ids, including ids that may not have a corresponding folded observation. */
	droppedObservationIds: Set<string>;
	/** All first-valid reflection records encountered through the fold boundary. */
	reflections: Reflection[];
	/** All first-valid observation records by id, including dropped observations. */
	observationsById: Map<string, Observation>;
	/** All first-valid reflection records by id. */
	reflectionsById: Map<string, Reflection>;
};

/**
 * Fold the branch ledger (`branchLedger`): every observation and reflection the
 * branch recorded, plus drop tombstones.
 *
 * Observations and reflections use first-valid-record-wins semantics. Drops are tombstones and are
 * retained even when the dropped id is unknown at the time of folding.
 */
export function foldLedger(entries: Entry[]): FoldedLedger {
	const observationsById = new Map<string, Observation>();
	const reflectionsById = new Map<string, Reflection>();
	const droppedObservationIds = new Set<string>();

	for (const { entry } of branchLedger(entries)) {
		switch (entry.customType) {
			case OM_OBSERVATIONS_RECORDED:
				for (const observation of entry.data.observations) {
					if (!observationsById.has(observation.id)) observationsById.set(observation.id, observation);
				}
				break;
			case OM_REFLECTIONS_RECORDED:
				for (const reflection of entry.data.reflections) {
					if (!reflectionsById.has(reflection.id)) reflectionsById.set(reflection.id, reflection);
				}
				break;
			case OM_OBSERVATIONS_DROPPED:
				for (const observationId of entry.data.observationIds) droppedObservationIds.add(observationId);
				break;
		}
	}

	const observations = Array.from(observationsById.values());
	const activeObservations = observations.filter((observation) => !droppedObservationIds.has(observation.id));
	const reflections = Array.from(reflectionsById.values());

	return {
		observations,
		activeObservations,
		droppedObservationIds,
		reflections,
		observationsById,
		reflectionsById,
	};
}
