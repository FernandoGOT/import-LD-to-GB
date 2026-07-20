export async function requestJson<T>(
  url: string,
  init: RequestInit,
  attempt = 1,
): Promise<T> {
  const response = await fetch(url, init);

  if (response.status === 429 && attempt <= 5) {
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader
      ? Number(retryAfterHeader) * 1000
      : 1000 * attempt;

    await delay(Number.isFinite(retryAfterMs) ? retryAfterMs : 1000 * attempt);
    return requestJson<T>(url, init, attempt + 1);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `HTTP ${response.status} ${response.statusText} em ${url}: ${text}`,
    );
  }

  return (await response.json()) as T;
}

export function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value || value.trim() === "") {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }

  return value;
}

export function parseBoolean(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value == null || value.trim() === "") return fallback;

  const normalized = value.trim().toLowerCase();

  if (["true", "1", "yes", "y", "sim"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "nao", "não"].includes(normalized)) {
    return false;
  }

  return fallback;
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProjectMap(
  value: string | undefined,
): Record<string, string> {
  if (!value || value.trim() === "") return {};

  try {
    const parsed = JSON.parse(value) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("PROJECT_MAP_JSON precisa ser um objeto JSON.");
    }

    return parsed as Record<string, string>;
  } catch (error) {
    throw new Error(
      `PROJECT_MAP_JSON inválido: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function deriveFeaturesApiBaseUrl(projectsBaseUrl: string): string {
  if (/\/api\/v1\b/.test(projectsBaseUrl)) {
    return projectsBaseUrl.replace(/\/api\/v1\b/, "/api/v2");
  }

  return projectsBaseUrl;
}
