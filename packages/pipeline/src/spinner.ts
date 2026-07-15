const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let interval: ReturnType<typeof setInterval> | null = null;
let frameIdx = 0;
let currentMsg = "";
let elapsed = 0;

/** Start a terminal spinner with a message. */
export function startSpinner(message: string): void {
  stopSpinner();
  currentMsg = message;
  frameIdx = 0;
  elapsed = 0;
  const write = () => {
    const frame = FRAMES[frameIdx % FRAMES.length]!;
    const secs = elapsed;
    process.stderr.write(`\r${frame} ${currentMsg} (${secs}s)`);
    frameIdx++;
    elapsed++;
  };
  write();
  interval = setInterval(write, 1000);
}

/** Stop the spinner and clear the line. */
export function stopSpinner(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    // Clear the spinner line
    process.stderr.write("\r" + " ".repeat(currentMsg.length + 20) + "\r");
  }
}
