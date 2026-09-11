/** Decode terminal controls across input chunks without treating escape-sequence bytes as commands. */
export class TerminalKeys {
  private state: "plain" | "escape" | "csi" | "ss3" | "paste" = "plain";
  private sequence = "";
  private pasteEnd = "";
  feed(input: string): string[] {
    const keys: string[] = [];
    for (const character of input) {
      if (character === "\u0003") {
        keys.push(character);
        this.state = "plain";
        this.sequence = this.pasteEnd = "";
        continue;
      }
      if (this.state === "paste") {
        this.pasteEnd = (this.pasteEnd + character).slice(-6);
        if (this.pasteEnd === "\u001b[201~") {
          this.state = "plain";
          this.pasteEnd = "";
        }
        continue;
      }
      if (character === "\u001b") {
        this.state = "escape";
        this.sequence = "";
        continue;
      }
      if (this.state === "escape") {
        this.state =
          character === "[" ? "csi" : character === "O" ? "ss3" : "plain";
        continue;
      }
      if (this.state === "ss3") {
        if (character === "C") keys.push("right");
        if (character === "D") keys.push("left");
        this.state = "plain";
        continue;
      }
      if (this.state === "csi") {
        if (character >= "@" && character <= "~") {
          if (character === "C" && this.sequence === "") keys.push("right");
          if (character === "D" && this.sequence === "") keys.push("left");
          this.state =
            character === "~" && this.sequence === "200" ? "paste" : "plain";
          this.sequence = "";
        } else if (this.sequence.length < 32) this.sequence += character;
        // Overflow remains an ignored sequence until its final byte; it cannot become commands.
        continue;
      }
      keys.push(character);
    }
    return keys;
  }
}
