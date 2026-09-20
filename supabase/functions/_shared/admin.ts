export function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function validUsername(value: string): boolean {
  return /^[a-z0-9_]{3,24}$/.test(value);
}

export function placeholderEmail(username: string): string {
  return `${normalizeUsername(username)}@users.soda.invalid`;
}

export function temporaryPassword(length = 20): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  const body = [...bytes].map((value) => alphabet[value % alphabet.length]).join("");
  return `Aa1!${body}`.slice(0, Math.max(16, length));
}
