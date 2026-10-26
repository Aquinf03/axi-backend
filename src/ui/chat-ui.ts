/** Standalone stub — replaced by real TTY UI when scripts/link-ui.mjs finds a frontend. */

export async function startChatUi(_train: string, _resumeId?: string): Promise<void> {
  throw new Error(
    "TTY UI is not linked. Place axi-backend under a repo with src/ui (and optional ../.axi_root), " +
      "set AXI_UI_PATH to that ui directory, then re-run npm run build.",
  )
}
