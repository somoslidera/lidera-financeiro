// Busca as cobranças no Asaas e publica um arquivo criptografado ao lado do app.
// Segredos vêm do ambiente: ASAAS_API_KEY (chave do Asaas) e ASAAS_ENC_KEY (chave de criptografia, base64).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { webcrypto as crypto, createHash } from 'node:crypto';

const BASE = 'https://api.asaas.com/v3';
const KEY = process.env.ASAAS_API_KEY;
const ENC = process.env.ASAAS_ENC_KEY;
if (!KEY) { console.error('Falta ASAAS_API_KEY'); process.exit(1); }
if (!ENC) { console.error('Falta ASAAS_ENC_KEY'); process.exit(1); }

async function buscarTudo(caminho) {
  const itens = [];
  let offset = 0;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${BASE}/${caminho}?limit=100&offset=${offset}`, {
      headers: { access_token: KEY, 'User-Agent': 'financeiro-lidera' }
    });
    if (!r.ok) throw new Error(`Asaas ${caminho} respondeu ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    itens.push(...(d.data || []));
    if (!d.hasMore) break;
    offset += 100;
  }
  return itens;
}

const [pagamentos, clientes] = await Promise.all([buscarTudo('payments'), buscarTudo('customers')]);
const nomes = {};
clientes.forEach(c => { nomes[c.id] = c.name || c.company || ''; });

// telefone no formato do WhatsApp (55 + DDD + número), ou null se não der pra usar
function fone(c) {
  let n = String((c && (c.mobilePhone || c.phone)) || '').replace(/\D/g, '');
  if (!n) return null;
  if (n.length === 10 || n.length === 11) n = '55' + n;
  if (n.length < 12 || n.length > 13) return null;
  return n;
}
const clientesOut = clientes.map(c => ({
  id: c.id,
  nome: c.name || c.company || '',
  telefone: fone(c),
  pf: String(c.cpfCnpj || '').replace(/\D/g, '').length === 11   // pessoa física → dá pra chamar pelo nome
}));

const cobrancas = pagamentos.map(p => ({
  id: p.id,
  clienteId: p.customer || null,
  cliente: nomes[p.customer] || p.customer || '',
  link: p.invoiceUrl || p.bankSlipUrl || null,     // página de pagamento (Pix + boleto)
  valor: p.value,
  vencimento: p.dueDate,
  pagamento: p.paymentDate || p.clientPaymentDate || null,
  status: p.status,
  descricao: p.description || '',
  forma: p.billingType,
  parcela: (p.installmentNumber && p.installmentCount) ? `${p.installmentNumber}/${p.installmentCount}` : null
})).sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));

// credencial do WhatsApp (UAZAPI) viaja cifrada junto com os dados; o app usa para as cobranças em lote
const whats = process.env.UAZAPI_TOKEN
  ? { url: (process.env.UAZAPI_URL || 'https://roniautomacoes-pro.uazapi.com').replace(/\/$/, ''), token: process.env.UAZAPI_TOKEN }
  : null;
// ── resumo diário no WhatsApp do dono (às 8h de Brasília, ou quando pedido à mão) ──
const brt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
const isoBrt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const hojeBrt = isoBrt(brt);
const ontemBrt = isoBrt(new Date(brt.getTime() - 86400000));
const querResumo = process.env.ENVIAR_RESUMO === '1' || (process.env.GITHUB_EVENT_NAME === 'schedule' && brt.getHours() === 8);
if (querResumo) {
  const PAGOS = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
  const MORTO = ['REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL', 'DELETED'];
  const brl = v => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const titulo = s => { s = String(s || '').trim(); if (!s || /[a-z]/.test(s)) return s; const peq = new Set(['de','da','do','das','dos','e','a','o','em','no','na']);
    return s.toLowerCase().split(/\s+/).map((w, i) => (i && peq.has(w)) ? w : (w.length === 1 ? w.toUpperCase() : w.replace(/^(\w)/, c => c.toUpperCase()).replace(/(['’]\w)/g, c => c.toUpperCase()))).join(' '); };
  const apelido = n => { const m = String(n || '').match(/\(([^)]+)\)/); return titulo(m ? m[1].trim() : String(n || '').replace(/\s*\(.*?\)\s*/g, ' ').replace(/\b(LTDA|ME|EIRELI|S\/A)\b\.?/gi, '').replace(/\s+/g, ' ').trim()); };
  const dias = s => Math.max(0, Math.floor((brt - new Date(s + 'T00:00:00')) / 86400000));
  const vivos = cobrancas.filter(c => !MORTO.includes(c.status));
  const pagos = vivos.filter(c => PAGOS.includes(c.status) && c.pagamento && c.pagamento >= ontemBrt).sort((a, b) => (a.pagamento < b.pagamento ? 1 : -1));
  const abertos = vivos.filter(c => !PAGOS.includes(c.status));
  const venceHoje = abertos.filter(c => c.vencimento === hojeBrt);
  const atras = abertos.filter(c => c.vencimento < hojeBrt);
  const soma = l => l.reduce((a, c) => a + Number(c.valor), 0);
  // atrasados agrupados por cliente
  const porCli = {};
  atras.forEach(c => { const k = c.clienteId || c.cliente; (porCli[k] = porCli[k] || { nome: c.cliente, n: 0, v: 0, d: 0 }); porCli[k].n++; porCli[k].v += Number(c.valor); porCli[k].d = Math.max(porCli[k].d, dias(c.vencimento)); });
  const grupos = Object.values(porCli).sort((a, b) => b.d - a.d || b.v - a.v);
  const dataTxt = brt.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  let txt = `📊 *Financeiro Lidera* · ${dataTxt}\n`;
  txt += `\n✅ *Pagos desde ontem* (${pagos.length}) · R$ ${brl(soma(pagos))}\n`;
  txt += pagos.length ? pagos.map(c => `• ${apelido(c.cliente)} · R$ ${brl(c.valor)}`).join('\n') + '\n' : '• nenhum pagamento\n';
  txt += `\n📅 *Vencem hoje* (${venceHoje.length}) · R$ ${brl(soma(venceHoje))}\n`;
  txt += venceHoje.length ? venceHoje.map(c => `• ${apelido(c.cliente)} · R$ ${brl(c.valor)}`).join('\n') + '\n' : '• nada vence hoje\n';
  txt += `\n⚠️ *Atrasados* (${atras.length} boleto${atras.length === 1 ? '' : 's'} · ${grupos.length} cliente${grupos.length === 1 ? '' : 's'}) · R$ ${brl(soma(atras))}\n`;
  txt += grupos.length ? grupos.map(g => `• ${apelido(g.nome)} · ${g.n > 1 ? g.n + '× · ' : ''}R$ ${brl(g.v)} · ${g.d} d`).join('\n') + '\n' : '• ninguém em atraso 🎉\n';
  txt += `\nCobrar: financeiro.somoslidera.com.br`;
  const numero = String(process.env.RESUMO_NUMERO || '').replace(/\D/g, '');
  if (numero && process.env.UAZAPI_TOKEN) {
    const url = (process.env.UAZAPI_URL || 'https://roniautomacoes-pro.uazapi.com').replace(/\/$/, '') + '/send/text';
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', token: process.env.UAZAPI_TOKEN }, body: JSON.stringify({ number: numero, text: txt }) });
    console.log(r.ok ? `Resumo diário enviado para …${numero.slice(-4)}` : `Resumo diário FALHOU: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  } else {
    console.log('Resumo diário (sem RESUMO_NUMERO, só no log):\n' + txt);
  }
}

const conteudo = { versao: 2, total: cobrancas.length, geradoEm: new Date().toISOString(), cobrancas, clientes: clientesOut, whats };
console.log(`Asaas: ${cobrancas.length} cobranças (${clientes.length} clientes)`);

// criptografa com AES-256-GCM
const raw = Buffer.from(ENC, 'base64');
if (raw.length !== 32) { console.error('ASAAS_ENC_KEY deve ter 32 bytes em base64'); process.exit(1); }
const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(conteudo)));
const saida = {
  iv: Buffer.from(iv).toString('base64'),
  data: Buffer.from(new Uint8Array(ct)).toString('base64'),
  total: cobrancas.length,
  geradoEm: conteudo.geradoEm
};

// só reescreve se o conteúdo mudou (evita commit vazio todo dia)
const destino = 'asaas.enc.json';
if (existsSync(destino)) {
  try {
    const antigo = JSON.parse(readFileSync(destino, 'utf8'));
    if (antigo.total === saida.total) {
      const chaveAntiga = antigo.assinatura, nova = 'v2|' + cobrancas.map(c => `${c.id}:${c.status}:${c.valor}:${c.vencimento}:${c.link ? 1 : 0}`).join('|') + '|' + clientesOut.map(c => `${c.id}:${c.telefone || ''}`).join(',') + '|w:' + (whats ? whats.token.slice(-6) : '');
      const hashNovo = createHash('sha256').update(nova).digest('base64');
      if (chaveAntiga === hashNovo) { console.log('Sem mudanças — nada a publicar.'); process.exit(0); }
    }
  } catch {}
}
saida.assinatura = createHash('sha256').update('v2|' + cobrancas.map(c => `${c.id}:${c.status}:${c.valor}:${c.vencimento}:${c.link ? 1 : 0}`).join('|') + '|' + clientesOut.map(c => `${c.id}:${c.telefone || ''}`).join(',') + '|w:' + (whats ? whats.token.slice(-6) : '')).digest('base64');
writeFileSync(destino, JSON.stringify(saida));
console.log(`Publicado ${destino} (${saida.data.length} bytes cifrados)`);
