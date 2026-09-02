import { createCipheriv, createHmac, timingSafeEqual } from "node:crypto";

export const REDSYS_SIGNATURE_VERSION = "HMAC_SHA512_V2";
export const REDSYS_TEST_URL = "https://sis-t.redsys.es:25443/sis/realizarPago";
export const REDSYS_PRODUCTION_URL = "https://sis.redsys.es/sis/realizarPago";

export type RedsysConfig = {
  merchantCode: string;
  terminal: string;
  secretKey: string;
  environment: "test" | "production";
};

export function getRedsysConfig(): RedsysConfig | null {
  const merchantCode = process.env.REDSYS_MERCHANT_CODE?.trim() ?? "";
  const terminal = process.env.REDSYS_TERMINAL?.trim() ?? "";
  const secretKey = process.env.REDSYS_SECRET_KEY?.trim() ?? "";
  const environment = process.env.REDSYS_ENVIRONMENT === "production" ? "production" : "test";
  if (!/^\d{9}$/.test(merchantCode) || !/^\d{1,3}$/.test(terminal) || !secretKey) return null;
  return { merchantCode, terminal: terminal.padStart(3, "0"), secretKey, environment };
}

export function redsysEndpoint(environment: RedsysConfig["environment"]) {
  return environment === "production" ? REDSYS_PRODUCTION_URL : REDSYS_TEST_URL;
}

export function encodeMerchantParameters(parameters: Record<string, string>) {
  return Buffer.from(JSON.stringify(parameters), "utf8").toString("base64url");
}

export function decodeMerchantParameters(encoded: string): Record<string, unknown> {
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const value: unknown = JSON.parse(decoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parámetros Redsys no válidos");
  return value as Record<string, unknown>;
}

function operationKey(secretKey: string, order: string) {
  const normalizedKey = secretKey.length >= 16 ? secretKey.slice(0, 16) : secretKey.padEnd(16, "0");
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(normalizedKey, "utf8"), Buffer.alloc(16));
  return Buffer.concat([cipher.update(order, "utf8"), cipher.final()]);
}

export function signMerchantParameters(encodedParameters: string, order: string, secretKey: string) {
  return createHmac("sha512", operationKey(secretKey, order))
    .update(encodedParameters, "utf8")
    .digest("base64url");
}

export function verifyRedsysSignature(encodedParameters: string, receivedSignature: string, order: string, secretKey: string) {
  const expected = Buffer.from(signMerchantParameters(encodedParameters, order, secretKey), "base64url");
  let received: Buffer;
  try { received = Buffer.from(receivedSignature, "base64url"); } catch { return false; }
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function parameter(parameters: Record<string, unknown>, name: string) {
  const found = Object.entries(parameters).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return found && (typeof found[1] === "string" || typeof found[1] === "number") ? String(found[1]) : "";
}

export function isApprovedResponse(response: string) {
  return /^\d{4}$/.test(response) && Number(response) >= 0 && Number(response) <= 99;
}
