const MARKET_BASE = 'https://api.massive.com';
const SEC_BASE = 'https://data.sec.gov';
const CACHE_SECONDS = 120;
const ALLOWED_ORIGINS = new Set(['https://finance.sharecapsule.org']);
const HIGH_WORDS = ['earnings','guidance','acquisition','acquire','merger','fda','lawsuit','investigation','bankruptcy','offering','buyback','repurchase','dividend','ceo','cfo','cyber','breach','recall','restatement','default','contract'];
const MEDIUM_WORDS = ['upgrade','downgrade','price target','analyst','partnership','launch','approval','forecast','restructuring','layoff','settlement'];
const HIGH_FORMS = new Set(['8-K','10-Q','10-K','S-1','S-3','424B2','424B3','424B4','424B5']);
const MEDIUM_FORMS = new Set(['DEF 14A','SC 13D','SC 13G','4']);
const IMPACT_WEIGHT = {high:3, medium:2, low:1};

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : '';
  return {...(allowed ? {'Access-Control-Allow-Origin':allowed} : {}),'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Accept, Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin'};
}
function json(body,status,origin,extra={}) {
  return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...cors(origin),...extra}});
}
async function market(path,apiKey,required=true) {
  const join = path.includes('?') ? '&' : '?';
  const response = await fetch(`${MARKET_BASE}${path}${join}apiKey=${encodeURIComponent(apiKey)}`,{headers:{Accept:'application/json'},cf:{cacheTtl:60,cacheEverything:true}});
  if (!response.ok) { if (required) throw new Error(`Market provider returned ${response.status}`); return null; }
  return response.json();
}
function impactFromText(title,description) {
  const text = `${title||''} ${description||''}`.toLowerCase();
  const high = HIGH_WORDS.find((word)=>text.includes(word));
  if (high) return {impact:'high',reason:`Contains a commonly market-sensitive event/topic: ${high}.`};
  const medium = MEDIUM_WORDS.find((word)=>text.includes(word));
  if (medium) return {impact:'medium',reason:`Contains a potentially relevant investor catalyst: ${medium}.`};
  return {impact:'low',reason:'Recent ticker-linked coverage; no high-priority catalyst keyword was detected.'};
}
function normalizeDirection(sentiment) {
  const value = String(sentiment||'').trim().toLowerCase();
  if (value === 'positive' || value === 'bullish') return 'positive';
  if (value === 'negative' || value === 'bearish') return 'negative';
  return 'neutral';
}
function normalizeNews(ticker,results) {
  return (Array.isArray(results)?results:[]).slice(0,20).map((article)=>{
    const insight = Array.isArray(article.insights) ? article.insights.find((item)=>String(item.ticker||'').toUpperCase()===ticker) : null;
    const scored = impactFromText(article.title,article.description);
    const direction = normalizeDirection(insight?.sentiment);
    return {id:article.id,title:article.title||'Untitled article',summary:article.description||'',publisher:article.publisher?.name||'Publisher',publishedAt:article.published_utc||null,url:article.article_url||article.amp_url||'',direction,sentiment:direction,sentimentReason:insight?.sentiment_reasoning||'',impact:scored.impact,impactReason:scored.reason};
  }).filter((item)=>item.url);
}
function summarizeNews(news) {
  const summary={positive:0,negative:0,neutral:0,highImpact:0,mediumImpact:0,lowImpact:0,score:0,label:'No recent news',basis:'No ticker-linked news was returned.'};
  if (!news.length) return summary;
  let signed=0,total=0;
  for (const item of news) {
    const direction=item.direction||'neutral'; const impact=item.impact||'low';
    summary[direction]=(summary[direction]||0)+1; summary[`${impact}Impact`]=(summary[`${impact}Impact`]||0)+1;
    const weight=IMPACT_WEIGHT[impact]||1; total+=weight;
    if(direction==='positive') signed+=weight; if(direction==='negative') signed-=weight;
  }
  summary.score=total?Math.round((signed/total)*100):0;
  if(summary.score>=35) summary.label='Positive news skew'; else if(summary.score>=10) summary.label='Slightly positive'; else if(summary.score<=-35) summary.label='Negative news skew'; else if(summary.score<=-10) summary.label='Slightly negative'; else summary.label='Mixed / neutral';
  summary.basis='Weighted by article sentiment and event significance. This describes recent news tone, not expected price direction.';
  return summary;
}
function secFilingUrl(cik,accession,primaryDocument) {
  if(!cik||!accession||!primaryDocument) return '';
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${String(accession).replace(/-/g,'')}/${encodeURIComponent(primaryDocument)}`;
}
async function secFilings(cik,userAgent) {
  if(!cik||!userAgent) return [];
  const response=await fetch(`${SEC_BASE}/submissions/CIK${String(cik).padStart(10,'0')}.json`,{headers:{Accept:'application/json','User-Agent':userAgent,'Accept-Encoding':'gzip, deflate'},cf:{cacheTtl:60,cacheEverything:true}});
  if(!response.ok) return [];
  const recent=(await response.json()).filings?.recent||{}; const forms=recent.form||[]; const filings=[];
  for(let i=0;i<forms.length&&filings.length<12;i++) {
    const form=forms[i]; if(!HIGH_FORMS.has(form)&&!MEDIUM_FORMS.has(form)) continue;
    filings.push({form,filed:(recent.filingDate||[])[i]||'',acceptedAt:(recent.acceptanceDateTime||[])[i]||null,description:(recent.primaryDocDescription||[])[i]||`SEC Form ${form}`,impact:HIGH_FORMS.has(form)?'high':'medium',url:secFilingUrl(cik,(recent.accessionNumber||[])[i],(recent.primaryDocument||[])[i])});
  }
  return filings;
}
function normalizedQuote(snapshot,previousDay) {
  if(snapshot?.ticker){const t=snapshot.ticker,day=t.day||{};return{price:t.lastTrade?.p??day.c??null,change:t.todaysChange??null,changePercent:t.todaysChangePerc??null,open:day.o??null,high:day.h??null,low:day.l??null,close:day.c??null,volume:day.v??null,asOf:t.updated?new Date(Number(t.updated)/1e6).toISOString():null,mode:'snapshot'};}
  const bar=previousDay?.results?.[0]||{};return{price:bar.c??null,change:null,changePercent:null,open:bar.o??null,high:bar.h??null,low:bar.l??null,close:bar.c??null,volume:bar.v??null,asOf:bar.t?new Date(Number(bar.t)).toISOString():null,mode:'previous-close'};
}
async function buildPayload(symbol,env) {
  const [snapshot,previousDay,newsResponse,details]=await Promise.all([
    market(`/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`,env.POLYGON_API_KEY,false),
    market(`/v2/aggs/ticker/${encodeURIComponent(symbol)}/prev?adjusted=true`,env.POLYGON_API_KEY,false),
    market(`/v2/reference/news?ticker=${encodeURIComponent(symbol)}&limit=20&sort=published_utc&order=desc`,env.POLYGON_API_KEY,true),
    market(`/v3/reference/tickers/${encodeURIComponent(symbol)}`,env.POLYGON_API_KEY,true)
  ]);
  const company=details?.results||{}; const news=normalizeNews(symbol,newsResponse?.results); const filings=await secFilings(company.cik,env.SEC_USER_AGENT);
  return {ticker:symbol,company:{name:company.name||symbol,exchange:company.primary_exchange||null,cik:company.cik||null},quote:normalizedQuote(snapshot,previousDay),newsSummary:summarizeNews(news),news,filings,generatedAt:new Date().toISOString(),privacy:'Public market data response. No user finance data is accepted or stored by this application endpoint.'};
}
export default {
  async fetch(request,env,ctx) {
    const origin=request.headers.get('Origin')||'';
    if(request.method==='OPTIONS'){if(origin&&!ALLOWED_ORIGINS.has(origin))return json({error:'Origin not allowed'},403,origin,{'Cache-Control':'no-store'});return new Response(null,{status:204,headers:cors(origin)});}
    if(request.method!=='GET') return json({error:'Method not allowed'},405,origin,{'Cache-Control':'no-store'});
    if(origin&&!ALLOWED_ORIGINS.has(origin)) return json({error:'Origin not allowed'},403,origin,{'Cache-Control':'no-store'});
    if(!env.POLYGON_API_KEY) return json({error:'Market provider is not configured'},503,origin,{'Cache-Control':'no-store'});
    const url=new URL(request.url); if(url.pathname!=='/v1/ticker') return json({error:'Not found'},404,origin,{'Cache-Control':'no-store'});
    const symbol=String(url.searchParams.get('symbol')||'').trim().toUpperCase(); if(!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) return json({error:'Invalid ticker symbol'},400,origin,{'Cache-Control':'no-store'});
    const cache=caches.default; const cacheKey=new Request(`https://public-market-cache.sharecapsule.invalid/v1/ticker/${encodeURIComponent(symbol)}`); const cached=await cache.match(cacheKey);
    if(cached){const response=new Response(cached.body,cached);Object.entries(cors(origin)).forEach(([key,value])=>value&&response.headers.set(key,value));response.headers.set('X-ShareCapsule-Cache','HIT');return response;}
    try{const payload=await buildPayload(symbol,env);const response=json(payload,200,origin,{'Cache-Control':`public, max-age=60, s-maxage=${CACHE_SECONDS}`,'X-ShareCapsule-Cache':'MISS'});const copy=new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers:response.headers});copy.headers.delete('Access-Control-Allow-Origin');copy.headers.delete('Vary');ctx.waitUntil(cache.put(cacheKey,copy));return response;}catch(error){return json({error:error?.message||'Unable to load public market data'},502,origin,{'Cache-Control':'no-store'});}
  }
};
