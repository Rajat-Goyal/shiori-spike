export function supabaseHeaders(
  secretKey: string,
  contentType?: "application/json",
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    apikey: secretKey,
  };

  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(secretKey)) {
    headers.Authorization = `Bearer ${secretKey}`;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}
