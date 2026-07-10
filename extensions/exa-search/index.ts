import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCodeHandle, unregisterCodeHandle } from "../code-runner/hooks";
import { installEnvVarStatus, registerManagedEnvVar, unregisterManagedEnvVar } from "pi-extension-envvars/hooks";
import { installExaSearch } from "./registration";

export default function (pi: ExtensionAPI) {
	installExaSearch(pi, {
		registerManagedEnvVar,
		unregisterManagedEnvVar,
		installEnvVarStatus,
		registerCodeHandle,
		unregisterCodeHandle,
	});
}
