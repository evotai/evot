// These command names show results in the Remote transcript, not a prompt
// bubble. This is only the shared inventory; the host still checks arguments,
// window ownership and run state on every submission.
export function remoteLocalCommand(name: string | undefined): 'share' | 'version' | null {
  switch (name) {
    case '/share': return 'share'
    case '/version': return 'version'
    default: return null
  }
}
