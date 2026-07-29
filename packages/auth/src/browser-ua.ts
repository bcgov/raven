/** User-agent string, selected by host OS so SiteMinder does not get a mismatched UA. */
function buildUserAgent(): string {
  switch (process.platform) {
    case "win32":
      return (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
    case "linux":
      return (
        "Mozilla/5.0 (X11; Linux x86_64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
    default: // darwin and others
      return (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/131.0.0.0 Safari/537.36"
      );
  }
}

export const BROWSER_USER_AGENT = buildUserAgent();
