import { AppError } from "./primitives";
import { appUrl } from "./runtime";

export async function sendVerification(email: string, token: string): Promise<{ emailDelivery: "smtp" | "local-preview"; verificationUrl?: string }> {
  const url = new URL("/api/auth/verify", appUrl());
  url.searchParams.set("token", token);
  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === "development") return { emailDelivery: "local-preview", verificationUrl: url.toString() };
    throw new AppError("Email delivery is unavailable. Contact the site administrator.", 503);
  }
  if (!process.env.SMTP_FROM) throw new AppError("Email delivery is not configured correctly.", 503);
  const { default: nodemailer } = await import("nodemailer");
  const port = Number(process.env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("Email delivery is not configured correctly.", 503);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.NODE_ENV === "production" && process.env.SMTP_SECURE !== "true",
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM,
      to: { address: email, name: "" },
      subject: "Verify your email — dark-exchange.com",
      text: `Verify your email address to access the exchange demonstration:\n\n${url.toString()}\n\nThis link expires in 24 hours and works once. All balances are TEST USDT with no monetary value. If you did not create this account, ignore this message.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#14201e"><h1>Verify your email</h1><p>Confirm your email address to access the exchange demonstration.</p><p><a style="display:inline-block;background:#1c7458;color:white;padding:14px 22px;border-radius:8px;text-decoration:none" href="${url.toString()}">Verify email address</a></p><p>This link expires in 24 hours and works once.</p><p>All balances are TEST USDT with no monetary value. If you did not create this account, ignore this message.</p></div>`,
    });
    return { emailDelivery: "smtp" };
  } catch {
    throw new AppError("We could not send the verification email. Please try resending it.", 503);
  } finally { transport.close(); }
}
