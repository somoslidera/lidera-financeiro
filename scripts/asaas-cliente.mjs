// Corrige dados de contato de um cliente no Asaas. Recebe o pedido CIFRADO (AES-GCM com ASAAS_ENC_KEY)
// porque o log de repositório público é público. Pedido: { id: "cus_...", mobilePhone: "17999999999" }
import { webcrypto as crypto } from 'node:crypto';
const BASE = 'https://api.asaas.com/v3', KEY = process.env.ASAAS_API_KEY, ENC = process.env.ASAAS_ENC_KEY, PAY = process.env.PEDIDO;
const key = await crypto.subtle.importKey('raw', Buffer.from(ENC, 'base64'), { name: 'AES-GCM' }, false, ['decrypt']);
const p = JSON.parse(Buffer.from(PAY, 'base64').toString());
const ped = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(p.iv, 'base64') }, key, Buffer.from(p.data, 'base64'))));
const H = { access_token: KEY, 'User-Agent': 'financeiro-lidera', 'Content-Type': 'application/json' };
const mask = s => s ? '…' + String(s).replace(/\D/g, '').slice(-4) : '(vazio)';
const antes = await (await fetch(`${BASE}/customers/${ped.id}`, { headers: H })).json();
console.log(`antes: celular ${mask(antes.mobilePhone)} · fixo ${mask(antes.phone)}`);
const corpo = {}; if (ped.mobilePhone) corpo.mobilePhone = ped.mobilePhone; if ('phone' in ped) corpo.phone = ped.phone;
const r = await fetch(`${BASE}/customers/${ped.id}`, { method: 'POST', headers: H, body: JSON.stringify(corpo) });
const depois = await r.json();
if (!r.ok) { console.log(`ERRO ${r.status}: ${JSON.stringify(depois).slice(0, 200)}`); process.exit(1); }
console.log(`depois: celular ${mask(depois.mobilePhone)} · fixo ${mask(depois.phone)} ✓`);
