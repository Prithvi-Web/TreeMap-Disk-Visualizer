declare module 'sudo-prompt' {
  interface SudoPromptOptions {
    name?: string;
    icns?: string;
    env?: Record<string, string>;
  }

  interface SudoPrompt {
    exec(
      cmd: string,
      options: SudoPromptOptions,
      callback: (error: Error | null, stdout?: string | Buffer, stderr?: string | Buffer) => void,
    ): void;
  }

  const sudoPrompt: SudoPrompt;
  export default sudoPrompt;
}
