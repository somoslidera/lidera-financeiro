// Busca as cobranças no Asaas e publica um arquivo criptografado ao lado do app.
// Segredos vêm do ambiente: ASAAS_API_KEY (chave do Asaas) e ASAAS_ENC_KEY (chave de criptografia, base64).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

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

const cobrancas = pagamentos.map(p => ({
  id: p.id,
  cliente: nomes[p.customer] || p.customer || '',
  valor: p.value,
  vencimento: p.dueDate,
  pagamento: p.paymentDate || p.clientPaymentDate || null,
  status: p.status,
  descricao: p.description || '',
  forma: p.billingType,
  parcela: (p.installmentNumber && p.installmentCount) ? `${p.installmentNumber}/${p.installmentCount}` : null
})).sort((a, b) => String(a.vencimento).localeCompare(String(b.vencimento)));

const conteudo = { total: cobrancas.length, geradoEm: new Date().toISOString(), cobrancas };
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
      const chaveAntiga = antigo.assinatura, nova = cobrancas.map(c => `${c.id}:${c.status}:${c.valor}:${c.vencimento}`).join('|');
      const hashNovo = Buffer.from(nova).toString('base64').slice(-64);
      if (chaveAntiga === hashNovo) { console.log('Sem mudanças — nada a publicar.'); process.exit(0); }
    }
  } catch {}
}
saida.assinatura = Buffer.from(cobrancas.map(c => `${c.id}:${c.status}:${c.valor}:${c.vencimento}`).join('|')).toString('base64').slice(-64);
writeFileSync(destino, JSON.stringify(saida));
console.log(`Publicado ${destino} (${saida.data.length} bytes cifrados)`);
