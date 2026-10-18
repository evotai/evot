/** Keep the server's explanation and stable diagnostic code visible together. */
export function loginDeniedMessage(result) {
  const reason = typeof result.reason === "string" ? result.reason.trim() : "";
  const code = typeof result.reason_code === "string" ? result.reason_code.trim() : "";
  if (!reason && !code) return "Login denied: server did not provide a reason; try again";
  return "Login denied" + (reason ? ": " + reason : "") + (code ? " [" + code + "]" : "");
}
