export function greeting(now = new Date()) {
  const h = Number(now.toLocaleString("en-IE", { timeZone: "Europe/Dublin", hour: "numeric", hourCycle: "h23" }));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
