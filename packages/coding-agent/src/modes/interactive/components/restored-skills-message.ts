// One transcript line for the message that restores skills after compaction, instead of the skills' whole text.
import { Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import { readRestoredSkillsDetails } from "../../../core/restored-skills.ts";

/** Render a restored-skills message as the names of the skills it restores and of those too large to restore. */
export const renderRestoredSkillsMessage: MessageRenderer = (message, options, theme) => {
	const { restored, tooLarge } = readRestoredSkillsDetails(message.details);
	const parts = [restored.length > 0 ? restored.join(", ") : "none"];
	if (tooLarge.length > 0) parts.push(`too large, named only: ${tooLarge.join(", ")}`);
	const label = theme.fg("customMessageLabel", theme.bold("[skills restored after compaction]"));
	return new Text(`${label} ${theme.fg("customMessageText", parts.join(" · "))}`, options.outputPad, 0);
};
