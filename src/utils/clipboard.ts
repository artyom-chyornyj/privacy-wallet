/**
 * Copy text to clipboard with fallback for older browsers.
 * @param text - The text string to copy to the clipboard
 */
export async function copyToClipboard (text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }
}
