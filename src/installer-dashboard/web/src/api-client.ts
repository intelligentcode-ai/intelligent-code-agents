export class IcaApiUnavailableError extends Error {
  code = "ICA_API_UNREACHABLE" as const;
}

export async function apiFetch(pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(pathname, init);
  } catch {
    throw new IcaApiUnavailableError(
      "Cannot reach ICA API through local dashboard proxy. Run 'ica serve --open=true' and use the URL printed by the CLI.",
    );
  }
}
