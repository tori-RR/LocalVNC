// Match the backend's HTTPS-only origin rules, including scheme-less IPv6.
export function normalizePveOrigin(value) {
  const input = String(value || "").trim().replace(/\/+$/, "");
  if (!input) throw new Error("PVE 需要主机地址。");
  let url;
  try { url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`); }
  catch { throw new Error("PVE 地址不正确，请填写主机地址及端口。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/"
      || /[?#]/.test(url.href)) throw new Error("PVE 地址必须是 HTTPS 主机，可带端口，不能包含账号或路径。");
  return url.origin;
}
