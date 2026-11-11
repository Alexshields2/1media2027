/** Name shown in the greeting and sidebar. Set OWNER_NAME in Vercel to change it. */
export function ownerName() {
  return process.env.OWNER_NAME?.trim() || "there";
}

export function greeting(now = new Date()) {
  const h = Number(now.toLocaleString("en-IE", { timeZone: "Europe/Dublin", hour: "numeric", hourCycle: "h23" }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
