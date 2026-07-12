// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { AppSettingsDialog } from "@foxglove/studio-base/components/AppSettingsDialog";
import { ExportVideoDialog } from "@foxglove/studio-base/components/ExportVideoDialog";
import {
  useWorkspaceStore,
  WorkspaceContextStore,
} from "@foxglove/studio-base/context/Workspace/WorkspaceContext";

import { useWorkspaceActions } from "../context/Workspace/useWorkspaceActions";

const selectWorkspacePrefsDialogOpen = (store: WorkspaceContextStore) =>
  store.dialogs.preferences.open;
const selectExportVideoDialogOpen = (store: WorkspaceContextStore) =>
  store.dialogs.exportVideo.open;

/**
 * Encapsulates dialogs shown and controlled at workspace level.
 */
export function WorkspaceDialogs(): JSX.Element {
  const prefsDialogOpen = useWorkspaceStore(selectWorkspacePrefsDialogOpen);
  const exportVideoOpen = useWorkspaceStore(selectExportVideoDialogOpen);
  const { dialogActions } = useWorkspaceActions();

  return (
    <>
      {prefsDialogOpen && (
        <AppSettingsDialog
          id="app-settings-dialog"
          open
          onClose={() => {
            dialogActions.preferences.close();
          }}
        />
      )}
      {exportVideoOpen && (
        <ExportVideoDialog
          open
          onClose={() => {
            dialogActions.exportVideo.close();
          }}
        />
      )}
    </>
  );
}
