'use strict';
const { PaperOrderEngine } = require('./perps-paper-orders');
const { executePending, roundDown } = require('./perps-grid-execution');
const STRATEGY = Object.freeze({
  id: 'independent-btc-eth-original-grid-v1', name: 'BTC long / ETH short · Capital units',
  mode: 'PAPER ONLY', leverage: 5, stepPercent: .5, adjustmentUnits: 2,
  initialUnits: { BTC: 30, ETH: 20 },
  levelPolicy: 'Original-entry anchored 0.5% levels, once per level. Favourable: reduce two equity units; adverse: add two. Skipped additions can retry while the level still qualifies. Fully closed sides never reopen.',
});
function fresh(leg, now) { return Number.isFinite(leg.mark) && leg.mark > 0 && leg.markAt <= now && now - leg.markAt <= 15000; }
function initialState(now) {
  return {
    schemaVersion: 1, strategyId: STRATEGY.id, createdAt: now, updatedAt: now,
    status: 'starting', statusMessage: 'Waiting for public Perps metadata and live prices.',
    account: { startingCapital: 5000, cash: 5000, realizedPnl: 0, fees: 0, fundingPnl: 0,
      peakEquity: 5000, maxDrawdown: 0 },
    legs: ['BTC', 'ETH'].map((symbol, index) => ({
      symbol, direction: index ? 'SHORT' : 'LONG', instrumentId: index ? 7 : 6,
      initialUnits: index ? 20 : 30, quantity: 0, entryPrice: null, originalEntry: null,
      initialized: false, closedPermanently: false, mark: null, markAt: null,
      levels: {}, pending: null, decision: 'Waiting to open initial allocation.',
    })),
    positions: [], trades: [], events: [], equityCurve: [{ at: now, equity: 5000 }],
    instruments: {}, tradeCounter: 0, halted: false,
    execution: { configuredLeverage: 5, latencyMs: 500, feeSchedule: [], feeEstimates: {}, feesUpdatedAt: null,
      fundingNote: 'Estimated hourly settlements using the last public rate and observed mark. Missed hours use last-known inputs and are explicitly flagged; not an exact exchange funding ledger.',
      liquidationNote: 'Cross-margin paper model. Maintenance = notional × 0.5 / market maximum leverage. A breach conservatively unwinds both sides at available books with published liquidation fees; exchange partial recovery, insurance and ADL are not reproduced.' },
  };
}
class PerpsGridBot {
  constructor({ api, store = null, clock = Date.now } = {}) {
    this.api = api; this.store = store; this.clock = clock; this.state = initialState(clock());
    this.persistenceError = null; this.lastSavedAt = null; this.busy = false;
    this.feeEngine = new PaperOrderEngine(this);
  }
  event(type, message) {
    const last = this.state.events[0];
    if (last?.type === type && last.message === message) return;
    this.state.events.unshift({ timestamp: this.clock(), type, message });
    this.state.events.length = Math.min(150, this.state.events.length);
  }
  async initialize() {
    const saved = await this.store?.load();
    if (saved) {
      if (saved.strategyId !== STRATEGY.id) throw new Error('Independent strategy ledger mismatch: refusing to import copy history.');
      this.validate(saved); this.state = saved;
      this.state.status = 'starting'; this.state.statusMessage = 'Restored independent positions and used levels; refreshing live prices.';
    }
    await this.persist();
  }
  validate(s) {
    if (!Array.isArray(s.legs) || s.legs.length !== 2 || !Array.isArray(s.trades)
      || s.account?.startingCapital !== 5000 || !Number.isFinite(s.account.cash)
      || !Array.isArray(s.equityCurve) || !Number.isFinite(s.tradeCounter)) throw new Error('Invalid independent paper ledger');
    const expected = ['BTC','ETH'];
    for (const [i, l] of s.legs.entries()) {
      if (l.symbol !== expected[i] || l.direction !== (i ? 'SHORT' : 'LONG') || l.instrumentId !== (i ? 7 : 6)
        || !Number.isFinite(l.quantity) || l.quantity < 0 || !l.levels
        || (l.quantity > 0 && !(l.entryPrice > 0))
        || (l.initialized && !(l.originalEntry > 0))
        || (l.closedPermanently && l.quantity > 0)) throw new Error('Invalid independent leg');
      if (l.pending && (!(l.pending.notionalRemaining >= 0) || !Number.isFinite(l.pending.createdAt)))
        throw new Error('Invalid pending adjustment');
    }
    const fees = s.trades.reduce((a,t) => a+t.fee,0), pnl = s.trades.reduce((a,t) => a+t.realizedPnl,0);
    if (new Set(s.trades.map(t=>t.id)).size!==s.trades.length
      || s.trades.some(t=>!['BTC','ETH'].includes(t.symbol) || !['BUY','SELL'].includes(t.side)
        || !(t.quantity>0) || !(t.price>0) || !Number.isFinite(t.fee) || !Number.isFinite(t.realizedPnl)))
      throw new Error('Invalid or duplicated independent fills');
    for (const l of s.legs) {
      const signed=s.trades.filter(t=>t.symbol===l.symbol)
        .reduce((sum,t)=>sum+(t.side==='BUY'?1:-1)*t.quantity,0);
      if (Math.abs(signed-l.quantity*(l.direction==='LONG'?1:-1))>1e-7)
        throw new Error('Independent position quantity reconciliation failed');
    }
    if (!Number.isFinite(fees+pnl+s.account.fundingPnl)
      || Math.abs(fees-s.account.fees)>.0001 || Math.abs(pnl-s.account.realizedPnl)>.0001
      || Math.abs(5000+pnl-fees+s.account.fundingPnl-s.account.cash)>.0001)
      throw new Error('Independent ledger cash reconciliation failed');
  }
  reserve(pending) {
    return pending && ['OPEN','ADD'].includes(pending.kind)
      ? pending.notionalRemaining * (.2 + .001) : 0;
  }
  account() {
    const base = this.state.account, now = this.clock();
    const unpricedSymbols = this.state.legs.filter(l => l.quantity > 0 && !fresh(l, now)).map(l => l.symbol);
    const known = !unpricedSymbols.length;
    let floatingPnl = 0, openNotional = 0, maintenanceMargin = 0;
    for (const l of this.state.legs) {
      if (!l.quantity || !fresh(l,now)) continue;
      floatingPnl += l.quantity * (l.direction === 'LONG' ? 1 : -1) * (l.mark-l.entryPrice);
      const notional = l.quantity*l.mark; openNotional += notional;
      maintenanceMargin += notional*.5/Number(this.state.instruments[String(l.instrumentId)]?.maxLeverage || 50);
    }
    const equity = known ? base.cash+floatingPnl : null, initialMargin = known ? openNotional/5 : null;
    const pendingOrderMargin = this.state.legs.reduce((sum,l) => sum+this.reserve(l.pending),0);
    return { ...base, equityKnown: known, unpricedSymbols, floatingPnl: known ? floatingPnl : null,
      equity, openNotional: known ? openNotional : null, initialMargin, maintenanceMargin: known ? maintenanceMargin : null,
      pendingOrderMargin, freeMargin: known ? equity-initialMargin-pendingOrderMargin : null,
      unitValue: known ? Math.max(0,equity)/100 : null };
  }
  queue(leg, kind, level = null) {
    const a = this.account(), reducing = ['REDUCE','LIQUIDATE'].includes(kind);
    const instrument = this.state.instruments[String(leg.instrumentId)];
    const units = kind === 'OPEN' ? leg.initialUnits : 2;
    const unitValue = kind === 'OPEN' ? 50 : a.unitValue;
    const nominal = kind === 'LIQUIDATE' ? leg.quantity*leg.mark : units*unitValue*5;
    if (!instrument || (!reducing && (!a.equityKnown || a.equity <= 0))) return false;
    const rate = this.feeEngine.feeRate(instrument,'TAKER');
    if (!reducing && a.freeMargin < nominal*(.2+Math.max(.001,rate))) {
      leg.decision = 'Addition skipped: insufficient margin; retry if margin frees.'; return false;
    }
    const quantity = reducing ? Math.min(leg.quantity, roundDown(nominal/leg.mark,instrument.quantityDecimals)) : null;
    if ((reducing ? quantity*leg.mark : nominal) < Number(instrument.minNotional) && kind !== 'LIQUIDATE') {
      // An entire reduce-only residual is allowed; never create an opposite position.
      if (!(reducing && leg.quantity*leg.mark < Number(instrument.minNotional))) {
        leg.decision = 'Adjustment below exchange minimum notional.'; return false;
      }
    }
    const actualQuantity = reducing && nominal >= leg.quantity*leg.mark ? leg.quantity : quantity;
    const triggerPrice = level == null ? leg.mark : this.levelPrice(leg,level);
    leg.pending = { kind, level, createdAt: this.clock(), units, unitValue, equityAtSignal: a.equity,
      quantityRemaining: reducing ? actualQuantity : null,
      notionalRemaining: reducing ? actualQuantity*leg.mark : nominal,
      filledNotional: 0, filledQuantity: 0, fillCost: 0, triggerPrice,
      reason: kind === 'OPEN' ? `Initial ${units} units at 5×.`
        : kind === 'LIQUIDATE' ? 'Conservative paper liquidation: cross maintenance-margin breach.'
        : `${Math.abs(level)*.5}% ${level>0?'favourable':'adverse'} move from original entry: ${kind==='ADD'?'add':'reduce'} two current-equity units.` };
    if (level != null) leg.levels[String(level)] = {
      level, price: triggerPrice, action: kind, status: 'PENDING', at: this.clock(), filledNotional: 0,
    };
    leg.decision = `${kind} requested; waiting at least 500ms for a later executable book.`;
    this.event('ORDER_REQUESTED', `${leg.symbol}: ${kind} $${leg.pending.notionalRemaining.toFixed(2)} exposure; ${leg.pending.reason}`);
    return true;
  }
  finish(leg, status='DONE') {
    const p = leg.pending;
    if (p.kind === 'OPEN' && p.filledQuantity > 0) {
      leg.initialized = true; leg.originalEntry = p.fillCost/p.filledQuantity;
    }
    if (p.level != null) Object.assign(leg.levels[String(p.level)],{status,at:this.clock(),filledNotional:p.filledNotional});
    leg.decision = `${p.kind} ${status.toLowerCase()}: filled $${p.filledNotional.toFixed(2)} exposure.`;
    this.event('ORDER_COMPLETED',`${leg.symbol}: ${leg.decision}`);
    leg.pending = null;
  }
  levelPrice(leg,level) { return leg.originalEntry*(1+(leg.direction==='LONG'?1:-1)*level*.005); }
  nextLevel(leg,sign) {
    let i=sign;
    while (leg.levels[String(i)]) i+=sign;
    const price=this.levelPrice(leg,i);
    return price>0 ? {level:i,price,movePercent:i*.5} : null;
  }
  consider(leg) {
    if (leg.pending || leg.closedPermanently || this.state.halted) return;
    if (!leg.initialized) { this.queue(leg,'OPEN'); return; }
    const a=this.account();
    if (!a.equityKnown || !(a.equity>0)) {leg.decision='Waiting for both fresh marks before equity-based sizing.';return;}
    const move=(leg.direction==='LONG'?1:-1)*(leg.mark/leg.originalEntry-1);
    const magnitude=Math.floor((Math.abs(move)+1e-10)/.005);
    const sign=move>=0?1:-1;
    const next=this.nextLevel(leg,sign);
    if (next && Math.abs(next.level)<=magnitude) this.queue(leg,sign>0?'REDUCE':'ADD',next.level);
    else leg.decision='Waiting for an unused 0.5% original-entry level.';
  }
  async refreshMetadata() {
    const [rows,fees]=await Promise.all([this.api.instruments(),this.api.fees()]);
    if (!Array.isArray(rows) || !Array.isArray(fees.fee_schedule)) throw new Error('Public metadata or fees unavailable');
    for (const l of this.state.legs) {
      const m=rows.find(x=>Number(x.instrument_id)===l.instrumentId);
      if (!m || m.symbol!==l.symbol+'-USD' || m.close_only || m.post_only || Number(m.max_leverage)<5
        || !Number.isInteger(m.quantity_decimals) || !(Number(m.min_notional)>0)
        || !(Number(m.liquidation_fee)>=0)) throw new Error('BTC/ETH instrument is unavailable or does not support 5× taker orders');
      this.state.instruments[String(l.instrumentId)]={id:l.instrumentId,symbol:m.symbol,
        quantityDecimals:m.quantity_decimals,minNotional:Number(m.min_notional),maxLeverage:Number(m.max_leverage),
        category:m.category,feeOverride:m.fee_override||null,riskTiers:m.risk_tiers||[],liquidationFee:Number(m.liquidation_fee)};
    }
    this.state.execution.feeSchedule=fees.fee_schedule;this.state.execution.feesUpdatedAt=this.clock();
  }
  updateTickers(rows) {
    if (!Array.isArray(rows)) throw new Error('Public mark prices unavailable');
    const now=this.clock();
    for (const l of this.state.legs) {
      const t=rows.find(x=>Number(x.instrument_id)===l.instrumentId);
      const mark=Number(t?.mark_price),at=Number(t?.timestamp);
      if (!(mark>0) || !Number.isFinite(mark) || !Number.isFinite(at) || at>now || now-at>15000)
        throw new Error(`${l.symbol}: stale, future or missing mark; trading paused`);
    }
    for (const l of this.state.legs) {
      const t=rows.find(x=>Number(x.instrument_id)===l.instrumentId);
      const previous=l.fundingQuote, mark=Number(t.mark_price);
      if (previous && previous.deadline<=now && previous.deadline>(l.lastFundingAt||0)) {
        const hours=Math.floor((now-previous.deadline)/3600000)+1;
        const payment=-(l.direction==='LONG'?1:-1)*l.quantity*mark*previous.rate*hours;
        this.state.account.cash+=payment;this.state.account.fundingPnl+=payment;
        l.lastFundingAt=previous.deadline+(hours-1)*3600000;
        this.event('FUNDING_ESTIMATE',`${l.symbol}: estimated hourly funding ${payment.toFixed(4)} USD${hours>1?' using last-known rate across missed hours':''}.`);
      }
      const rate=Number(t.funding_rate),deadline=Number(t.next_funding);
      if (!Number.isFinite(rate) || Math.abs(rate)>.04 || !Number.isFinite(deadline) || deadline<=now)
        throw new Error(`${l.symbol}: current public hourly funding quote unavailable`);
      l.fundingQuote={rate,deadline,at:Number(t.timestamp)};
      l.mark=mark;l.markAt=Number(t.timestamp);
    }
  }
  async tick() {
    if(this.busy)return;this.busy=true;
    try {
      // Never continue to trade on an unsaved ledger.
      if(this.persistenceError)await this.persist();
      if(!this.state.execution.feesUpdatedAt || this.clock()-this.state.execution.feesUpdatedAt>3600000) await this.refreshMetadata();
      this.updateTickers(await this.api.tickers());
      const a=this.account();
      if(a.equityKnown && a.openNotional>0 && a.equity<a.maintenanceMargin && !this.state.halted) {
        this.state.halted=true;this.event('MAINTENANCE_BREACH','Paper maintenance margin breached; conservative liquidation, no further additions.');
        for(const l of this.state.legs){
          if(l.pending?.level!=null)l.levels[String(l.pending.level)].status='CANCELLED';
          l.pending=null;if(l.quantity>0)this.queue(l,'LIQUIDATE');
        }
      }
      // Reductions execute first, allowing margin they release to fund later additions.
      const ordered=[...this.state.legs].sort((a,b)=>Number(['REDUCE','LIQUIDATE'].includes(b.pending?.kind))-Number(['REDUCE','LIQUIDATE'].includes(a.pending?.kind)));
      for(const l of ordered)if(l.pending)await executePending(this,l);
      for(const l of this.state.legs)this.consider(l);
      const end=this.account();
      if(end.equityKnown){this.state.account.peakEquity=Math.max(this.state.account.peakEquity,end.equity);
        this.state.account.maxDrawdown=Math.max(this.state.account.maxDrawdown,this.state.account.peakEquity-end.equity);}
      this.state.status=this.state.halted?'risk_halt':'running';
      this.state.statusMessage=this.state.halted?'Conservative paper liquidation active; strategy will not restart automatically.':'Independent BTC long / ETH short. No master-wallet following.';
    }catch(e){this.state.status=this.persistenceError?'persistence_error':'waiting';this.state.statusMessage=e.message;this.event('WAIT',e.message);}
    finally{
      this.state.updatedAt=this.clock();
      const last=this.state.equityCurve.at(-1),equity=this.account().equity;
      if(!last || this.clock()-last.at>=30000 || (equity==null)!==(last.equity==null))
        this.state.equityCurve.push({at:this.clock(),equity});
      // Bound samples, never trade history or used levels.
      if(this.state.equityCurve.length>10000)this.state.equityCurve=this.state.equityCurve.filter((_,i)=>i===0||i%2===1);
      try{await this.persist();}catch(e){this.state.status='persistence_error';this.state.statusMessage=e.message;}
      this.busy=false;
    }
  }
  async persist() {
    if(!this.store)return;
    this.state.positions=this.state.legs.filter(l=>l.quantity>0).map(l=>({symbol:l.symbol,size:l.quantity*(l.direction==='LONG'?1:-1)}));
    try{await this.store.save(this.state);this.persistenceError=null;this.lastSavedAt=this.clock();}
    catch(e){this.persistenceError=e.message;throw e;}
  }
  start(){if(this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),2000);}
  async stopAndFlush(){clearInterval(this.timer);this.timer=null;while(this.busy)await new Promise(r=>setTimeout(r,20));await this.persist();}
  snapshot(){
    const now=this.clock(),a=this.account();
    return{...structuredClone(this.state),strategy:STRATEGY,mode:'PAPER ONLY',now,account:a,
      legs:this.state.legs.map(l=>({...structuredClone(l),levels:Object.values(l.levels),
        size:l.quantity*(l.direction==='LONG'?1:-1),mark:fresh(l,now)?l.mark:null,
        movePercent:fresh(l,now)&&l.originalEntry?(l.direction==='LONG'?1:-1)*(l.mark/l.originalEntry-1)*100:null,
        notional:fresh(l,now)?l.quantity*l.mark:null,margin:fresh(l,now)?l.quantity*l.mark/5:null,
        capitalUnits:fresh(l,now)&&a.unitValue>0?l.quantity*l.mark/5/a.unitValue:null,
        unrealizedPnl:!l.quantity?0:fresh(l,now)?l.quantity*(l.direction==='LONG'?1:-1)*(l.mark-l.entryPrice):null,
        nextFavourable:l.initialized&&!l.closedPermanently?this.nextLevel(l,1):null,
        nextAdverse:l.initialized&&!l.closedPermanently?this.nextLevel(l,-1):null})),
      persistence:{enabled:!!this.store,error:this.persistenceError,lastSavedAt:this.lastSavedAt}};
  }
}
module.exports={PerpsGridBot,STRATEGY,fresh,initialState};
