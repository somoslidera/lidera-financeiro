// Diagnóstico SOMENTE LEITURA: taxas, extrato de tarifas e configuração de notificações no Asaas.
// O resultado sai cifrado (AES-GCM com ASAAS_ENC_KEY) porque o log de repositório público é público.
import { webcrypto as crypto } from 'node:crypto';
const BASE = 'https://api.asaas.com/v3', KEY = process.env.ASAAS_API_KEY, ENC = process.env.ASAAS_ENC_KEY;
const H = { access_token: KEY, 'User-Agent': 'financeiro-lidera' };
const get = async p => { const r = await fetch(BASE + p, { headers: H }); const t = await r.text(); try { return { ok: r.ok, status: r.status, j: JSON.parse(t) }; } catch { return { ok: r.ok, status: r.status, j: t.slice(0, 300) }; } };
async function todos(p) { const out = []; let off = 0; for (let i = 0; i < 80; i++) { const sep = p.includes('?') ? '&' : '?'; const r = await get(`${p}${sep}limit=100&offset=${off}`); if (!r.ok) return { erro: r.status, corpo: r.j, parcial: out }; out.push(...(r.j.data || [])); if (!r.j.hasMore) break; off += 100; } return out; }
const R = { geradoEm: new Date().toISOString() };
R.fees = await get('/myAccount/fees');
R.conta = await get('/myAccount/commercialInfo');
const hoje = new Date(), ini = new Date(Date.now() - 180 * 86400000), d = x => x.toISOString().slice(0, 10);
R.transacoes = await todos(`/financialTransactions?startDate=${d(ini)}&finishDate=${d(hoje)}`);
const clientes = await todos('/customers');
R.clientes = Array.isArray(clientes) ? clientes.map(c => ({ id: c.id, nome: c.name, notificationDisabled: c.notificationDisabled, temEmail: !!c.email, temCel: !!(c.mobilePhone || c.phone) })) : clientes;
R.notificacoes = {};
if (Array.isArray(clientes)) for (const c of clientes) { const r = await get(`/customers/${c.id}/notifications`); R.notificacoes[c.id] = r.ok ? (r.j.data || []) : { erro: r.status, corpo: r.j }; }
const pays = await todos('/payments');
R.pagamentos = Array.isArray(pays) ? pays.map(p => ({ id: p.id, cli: p.customer, valor: p.value, liquido: p.netValue, status: p.status, tipo: p.billingType, venc: p.dueDate, pago: p.paymentDate || p.clientPaymentDate || null, desc: (p.description || '').slice(0, 60) })) : pays;
const raw = Buffer.from(ENC, 'base64'); const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(R)));
console.log('DIAG:' + Buffer.from(JSON.stringify({ iv: Buffer.from(iv).toString('base64'), data: Buffer.from(new Uint8Array(ct)).toString('base64') })).toString('base64'));
