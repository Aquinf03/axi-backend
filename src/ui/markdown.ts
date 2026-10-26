/** Standalone stub — identity renderer when TTY UI is not linked. */

export type MdState = { fence: boolean; math: boolean }

export type MdOpts = {
  /** Train / workspace root — unused in the stub. */
  baseDir?: string
}

/** Pass-through so `axi ask` still prints plain text without the frontend. */
export function renderMarkdown(src: string, _state?: MdState, _opts?: MdOpts): string {
  return src
}
