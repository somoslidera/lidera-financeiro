// Mantém DESLIGADOS os avisos do Asaas para os clientes (e-mail, SMS, WhatsApp e ligação),
// porque a cobrança agora sai pela régua de WhatsApp da Lidera. Avisos para a própria Lidera continuam.
// Roda a cada sincronização, então clientes novos também ficam desligados.
const BASE = 'https://api.asaas.com/v3', KEY = process.env.ASAAS_API_KEY;
if (!KEY) { console.error('Falta ASAAS_API_KEY'); process.exit(1); }
const H = { access_token: KEY, 'User-Agent': 'financeiro-lidera', 'Content-Type': 'application/json' };
async function todos(p) { const out = []; let off = 0; for (let i = 0; i < 60; i++) { const r = await fetch(`${BASE}${p}?limit=100&offset=${off}`, { headers: H }); if (!r.ok) throw new Error(`Asaas ${p} ${r.status}`); const d = await r.json(); out.push(...(d.data || [])); if (!d.hasMore) break; off += 100; } return out; }
const clientes = await todos('/customers');
let desligadas = 0, jaOk = 0, erros = 0;
for (const c of clientes) {
  const r = await fetch(`${BASE}/customers/${c.id}/notifications`, { headers: H });
  if (!r.ok) { erros++; continue; }
  for (const n of ((await r.json()).data || [])) {
    if (!(n.emailEnabledForCustomer || n.smsEnabledForCustomer || n.whatsappEnabledForCustomer || n.phoneCallEnabledForCustomer)) { jaOk++; continue; }
    const u = await fetch(`${BASE}/notifications/${n.id}`, { method: 'PUT', headers: H, body: JSON.stringify({ emailEnabledForCustomer: false, smsEnabledForCustomer: false, whatsappEnabledForCustomer: false, phoneCallEnabledForCustomer: false }) });
    if (u.ok) desligadas++; else { erros++; console.log(`  erro ${u.status} em ${n.event}: ${(await u.text()).slice(0, 160)}`); }
  }
}
console.log(`Avisos do Asaas p/ clientes: ${desligadas} desligado(s) agora · ${jaOk} já desligado(s) · ${erros} erro(s) · ${clientes.length} clientes`);
