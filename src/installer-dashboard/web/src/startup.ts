export interface RetryOptions {
  attempts?: number;
  initialDelayMs?: number;
}

export interface StartupTask {
  id: string;
  critical: boolean;
  run: () => Promise<void>;
}

export interface StartupSummary {
  warnings: string[];
  errors: string[];
}

function asMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return String(error || "Unknown error");
}

function isApiUnavailableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ICA_API_UNREACHABLE",
  );
}

export async function retryWithBackoff<T>(run: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 200);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export async function runStartupTasks(tasks: StartupTask[], retryOptions: RetryOptions = {}): Promise<StartupSummary> {
  const summary: StartupSummary = {
    warnings: [],
    errors: [],
  };

  for (const task of tasks) {
    try {
      await retryWithBackoff(task.run, retryOptions);
    } catch (error) {
      if (isApiUnavailableError(error)) {
        summary.errors.push(asMessage(error));
        break;
      }
      const message = `${task.id}: ${asMessage(error)}`;
      if (task.critical) {
        summary.errors.push(message);
      } else {
        summary.warnings.push(message);
      }
    }
  }

  return summary;
}
