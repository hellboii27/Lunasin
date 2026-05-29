// [CONFIG] Lunasin v1.7.0 | © 2026 Bayu Wicaksono

// [CONFIG] Sheet names, cache key, and lock timeout
var SHEET_DEBTS = 'debts';
var SHEET_INST  = 'installments';
var CACHE_KEY   = 'lunasin_debts_v5';
var CACHE_TTL   = 300;
var LOCK_MS     = 6000;

// [SECURITY] HTML entity encoding to prevent XSS attacks
function _sanitizeInput(str) {
  if (str == null || str === '') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// [SECURITY] Sanitize object properties recursively
function _sanitizeObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  var sanitized = {};
  for (var key in obj) {
    if (obj.hasOwnProperty(key)) {
      var val = obj[key];
      if (typeof val === 'string') {
        sanitized[key] = _sanitizeInput(val);
      } else if (typeof val === 'object' && val !== null) {
        sanitized[key] = _sanitizeObject(val);
      } else {
        sanitized[key] = val;
      }
    }
  }
  return sanitized;
}

// [CONFIG] Debts sheet column index map
var DC = {
  id:0, person_name:1, principal_amount:2, interest_amount:3,
  total_amount:4, paid_amount:5, remaining_amount:6,
  status:7, due_date:8, created_at:9, notes:10, updated_at:11,
  overpayment_amount:12, archived:13, penalty_total:14
};
var DEBT_HEADERS = [
  'id','person_name','principal_amount','interest_amount',
  'total_amount','paid_amount','remaining_amount',
  'status','due_date','created_at','notes','updated_at','overpayment_amount','archived','penalty_total'
];

// [CONFIG] Installments sheet column index map
var IC = { id:0, debt_id:1, payment_amount:2, payment_date:3, created_at:4, notes:5, penalty_amount:6 };
var INST_HEADERS = ['id','debt_id','payment_amount','payment_date','created_at','notes','penalty_amount'];

// [CONFIG] ScriptProperties keys for persistent ID counters
var _P_DEBT = 'lunasin_ctr_debt', _P_INST = 'lunasin_ctr_inst';

// [CONFIG] Rate limit — max requests per user per rolling window
var RATE_LIMIT_MAX = 30;
var RATE_LIMIT_WIN = 60;

// [SECURITY] Enforce per-user rate limit via ScriptProperties; throws if exceeded
function _checkRateLimit() {
  try {
    var user  = Session.getEffectiveUser().getEmail() || 'anonymous';
    var key   = 'rl_' + user.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
    var props = PropertiesService.getScriptProperties();
    var raw   = props.getProperty(key);
    var now   = Math.floor(Date.now() / 1000);
    var data  = raw ? JSON.parse(raw) : { count: 0, reset: now + RATE_LIMIT_WIN };
    if (now > data.reset) { data = { count: 0, reset: now + RATE_LIMIT_WIN }; }
    data.count++;
    if (data.count > RATE_LIMIT_MAX) {
      var wait = data.reset - now;
      throw new Error('Terlalu banyak permintaan. Coba lagi dalam ' + wait + ' detik.');
    }
    props.setProperty(key, JSON.stringify(data));
  } catch(e) {
    if (e.message && e.message.indexOf('Terlalu banyak') === 0) throw e;
    logWarn('_checkRateLimit infra error: ' + e.message);
  }
}

// [UTIL] Lazy-init timezone; caches spreadsheet TZ, falls back to Asia/Jakarta
var _TZ = null;
function _getTZ() {
  if (_TZ) return _TZ;
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) { var tz = ss.getSpreadsheetTimeZone(); if (tz && tz.length > 0) { _TZ = tz; return _TZ; } }
  } catch(e) {}
  _TZ = 'Asia/Jakarta';
  return _TZ;
}

// [API] Entry point; serves read-only ShareView if ?id= param present, else SPA
function doGet(e) {
  var debtId = e && e.parameter && e.parameter.id ? sStr(String(e.parameter.id), 50) : '';
  if (debtId) {
    var tmpl = HtmlService.createTemplateFromFile('ShareView');
    tmpl.debtId = debtId;
    var res = _getSingle(debtId);
    tmpl.debtJson = JSON.stringify(res.success ? res : { success: false, message: 'Data tidak ditemukan' });
    return tmpl.evaluate()
      .setTitle('Lunasin — Detail Utang')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return HtmlService.createTemplateFromFile('Index').evaluate()
    .setTitle('Lunasin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// [UTIL] GAS template include helper for <?!= include() ?> partials
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// [API] Route action string to handler; validates rate limit before dispatch
function processRequest(jsonStr) {
  try {
    _checkRateLimit();
    var params = JSON.parse(jsonStr);
    var action = sStr(params.action, 50);
    logInfo('ACTION ' + action);
    if      (action === 'getDebts')      return JSON.stringify(getDebts(params));
    else if (action === 'createDebt')    return JSON.stringify(createDebt(params));
    else if (action === 'updateDebt')    return JSON.stringify(updateDebt(params));
    else if (action === 'deleteDebt')    return JSON.stringify(deleteDebt(params));
    else if (action === 'addPayment')    return JSON.stringify(addPayment(params));
    else if (action === 'archiveDebt')   return JSON.stringify(archiveDebt(params));
    else if (action === 'unarchiveDebt') return JSON.stringify(unarchiveDebt(params));
    else if (action === 'healthCheck')   return JSON.stringify(healthCheck());
    else if (action === 'getAppUrl')     return JSON.stringify(getAppUrl());
    else if (action === 'addPenalty')    return JSON.stringify(addPenalty(params));
    return JSON.stringify({ success:false, message:'Unknown action: ' + action });
  } catch(err) {
    logError('processRequest', err);
    return JSON.stringify({ success:false, message: sStr(err.message,300) || 'Server error' });
  }
}

// [INIT] Bootstrap sheets and counters; run once on first deploy
function initApp() {
  logInfo('=== initApp START ===');
  try {
    var ss = _ss();
    logInfo('Spreadsheet: ' + ss.getName());
    getOrCreateSheet(SHEET_DEBTS);
    getOrCreateSheet(SHEET_INST);
    var probe = ss.getSheetByName(SHEET_DEBTS);
    if (!probe) throw new Error('Sheet probe failed');
    var props = PropertiesService.getScriptProperties();
    if (!props.getProperty('lunasin_ctr_debt')) props.setProperty('lunasin_ctr_debt','0');
    if (!props.getProperty('lunasin_ctr_inst')) props.setProperty('lunasin_ctr_inst','0');
    invalidateCache();
    logInfo('=== initApp OK ===');
    return { ok:true, message:'Lunasin initialized.' };
  } catch(err) { logError('initApp',err); return { ok:false, message:err.message }; }
}

// [API] Return deployed web app URL for share-link generation
function getAppUrl() {
  try {
    var url = ScriptApp.getService().getUrl();
    return { success: true, url: url };
  } catch(e) { return { success: false, message: e.message }; }
}

// [API] Return spreadsheet connectivity and row count status
function healthCheck() {
  try {
    var ss  = _ss();
    var sh  = getOrCreateSheet(SHEET_DEBTS);
    var ish = getOrCreateSheet(SHEET_INST);
    return { success:true, status:'healthy',
      debts:    Math.max(0, sh.getLastRow()-1),
      payments: Math.max(0, ish.getLastRow()-1),
      tz: _getTZ(), now: nowWIB(), spreadsheet: ss.getName() };
  } catch(err) { logError('healthCheck',err); return { success:false, status:'unhealthy', message:err.message }; }
}

// [UTIL] Log info message
function logInfo(m)      { try { Logger.log('[L:INFO] ' + m); } catch(e){} }
// [UTIL] Log error with context label
function logError(ctx,e) { try { Logger.log('[L:ERR] ' + ctx + ' — ' + (e&&(e.message||String(e)))); } catch(_){} }
// [UTIL] Log warning message
function logWarn(m)      { try { Logger.log('[L:WARN] ' + m); } catch(e){} }

// [UTIL] Return current timestamp as ISO string in active TZ
function nowWIB() {
  return Utilities.formatDate(new Date(), _getTZ(), "yyyy-MM-dd'T'HH:mm:ssZ")
         .replace(/(\d{2})(\d{2})$/, '$1:$2');
}

// [UTIL] Return today as yyyy-MM-dd in active TZ
function todayWIB() { return Utilities.formatDate(new Date(), _getTZ(), 'yyyy-MM-dd'); }

// [UTIL] Format Date or string to yyyy-MM-dd in active TZ
function fmtDate(v) {
  if (!v) return '';
  try {
    var d = (v instanceof Date) ? v : new Date(v);
    return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, _getTZ(), 'yyyy-MM-dd');
  } catch(e) { return ''; }
}

// [UTIL] Format Date or string to ISO datetime with TZ offset
function fmtDT(v) {
  if (!v) return '';
  try {
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return '';
    return Utilities.formatDate(d, _getTZ(), "yyyy-MM-dd'T'HH:mm:ssZ")
           .replace(/(\d{2})(\d{2})$/, '$1:$2');
  } catch(e) { return ''; }
}

// [UTIL] Increment persistent counter; falls back to random on failure
function _nextCtr(key) {
  try { var p=PropertiesService.getScriptProperties(); var n=(parseInt(p.getProperty(key)||'0',10)+1)%10000; p.setProperty(key,String(n)); return n; }
  catch(e){ logWarn('_nextCtr fallback'); return Math.floor(Math.random()*9000)+1000; }
}

// [UTIL] Return today as yyyyMMdd string for ID prefix
function _dateTag() { return Utilities.formatDate(new Date(), _getTZ(), 'yyyyMMdd'); }

// [DB] Check ID uniqueness against a sheet column
function _isUnique(id,sh,ci) {
  try { var lr=sh.getLastRow(); if(lr<=1)return true; var col=sh.getRange(2,ci+1,lr-1,1).getValues(); for(var i=0;i<col.length;i++){if(String(col[i][0])===id)return false;} return true; }
  catch(e){ return true; }
}

// [UTIL] Generate unique DEBT-YYYYMMDD-XXXX ID
function genDebtId(sh) {
  var id; for(var t=0;t<5;t++){ id='DEBT-'+_dateTag()+'-'+('0000'+_nextCtr(_P_DEBT)).slice(-4); if(!sh||_isUnique(id,sh,0))return id; } return id+'-'+Date.now();
}

// [UTIL] Generate unique INST-YYYYMMDD-XXXX ID
function genInstId(sh) {
  var id; for(var t=0;t<5;t++){ id='INST-'+_dateTag()+'-'+('0000'+_nextCtr(_P_INST)).slice(-4); if(!sh||_isUnique(id,sh,0))return id; } return id+'-'+Date.now();
}

// [DB] Return active spreadsheet; throws if not found
function _ss() {
  var ss=SpreadsheetApp.getActiveSpreadsheet();
  if(!ss)throw new Error('Spreadsheet tidak ditemukan. Pastikan skrip dijalankan dari Google Sheets.');
  return ss;
}

// [VALIDATION] Helper: Validate required ID parameter
function _requireId(params, paramName) {
  paramName = paramName || 'id';
  if (!params[paramName]) throw new Error(paramName + ' diperlukan');
  return sStr(String(params[paramName]), 50);
}

// [VALIDATION] Helper: Validate required name parameter
function _requireName(name) {
  name = sName(name);
  if (!name) throw new Error('Nama tidak boleh kosong');
  return name;
}

// [VALIDATION] Helper: Validate required positive amount
function _requirePositiveAmount(amount, fieldName) {
  amount = sRp(amount);
  if (amount <= 0) throw new Error((fieldName || 'Jumlah') + ' harus lebih dari 0');
  return amount;
}

// [DB] Helper: Find debt row by ID, throws if not found
function _findDebtRow(sh, id) {
  var lr = sh.getLastRow();
  if (lr <= 1) throw new Error('Debt tidak ditemukan: ' + id);
  
  var nc = sh.getLastColumn();
  var raw = sh.getRange(1, 1, lr, nc).getValues();
  
  for (var r = 1; r < raw.length; r++) {
    if (String(raw[r][DC.id]) === id) {
      return { rowNum: r + 1, row: raw[r], allRows: raw };
    }
  }
  
  throw new Error('Debt tidak ditemukan: ' + id);
}

// [DB] Helper: Check if debt ID exists (returns boolean)
function _debtExists(sh, id) {
  var lr = sh.getLastRow();
  if (lr <= 1) return false;
  
  var idcol = sh.getRange(1, 1, lr, 1).getValues();
  for (var r = 1; r < idcol.length; r++) {
    if (String(idcol[r][0]) === id) return true;
  }
  return false;
}

// [DB] Get or create named sheet; runs schema migration if already exists
function getOrCreateSheet(name) {
  var ss=_ss(), sh=ss.getSheetByName(name);
  if(!sh){
    logInfo('Creating sheet: '+name); sh=ss.insertSheet(name);
    var hdrs=(name===SHEET_DEBTS)?DEBT_HEADERS:INST_HEADERS;
    sh.appendRow(hdrs); sh.setFrozenRows(1); sh.getRange(1,1,1,hdrs.length).setFontWeight('bold');
  } else { _migrateSchema(sh,name); }
  return sh;
}

// [DB] Add missing columns without destroying existing data
function _migrateSchema(sh,name) {
  try {
    var expected=(name===SHEET_DEBTS)?DEBT_HEADERS:INST_HEADERS;
    var lastCol=sh.getLastColumn(); if(lastCol<1){sh.appendRow(expected);return;}
    var raw=sh.getRange(1,1,1,lastCol).getValues()[0];
    var existing=raw.map(function(v){return String(v).trim().toLowerCase();});
    var added=0;
    expected.forEach(function(h){
      if(existing.indexOf(h.toLowerCase())===-1){
        var col=lastCol+added+1; if(col>sh.getMaxColumns())sh.insertColumnsAfter(sh.getMaxColumns(),1);
        sh.getRange(1,col).setValue(h); logInfo('migrate['+name+']: added "'+h+'" col '+col); added++;
      }
    });
    if(added>0&&name===SHEET_DEBTS)_rebuildDC(sh);
  } catch(e){ logError('_migrateSchema:'+name,e); }
}

// [DB] Rebuild DC column map from actual sheet header row after migration
function _rebuildDC(sh) {
  try {
    var hdrs=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
    hdrs.forEach(function(h,i){ var k=String(h).trim().toLowerCase(); if(DC.hasOwnProperty(k))DC[k]=i; });
    logInfo('DC rebuilt: '+JSON.stringify(DC));
  } catch(e){ logError('_rebuildDC',e); }
}

// [SECURITY] Sanitize generic string; strip HTML tags and dangerous chars
function sStr(v,max)  { if(v===null||v===undefined)return ''; return String(v).replace(/<[^>]*>/g,'').replace(/[<>"'`]/g,'').trim().slice(0,max||500); }
// [SECURITY] Sanitize person name field
function sName(v)     { if(!v)return ''; return String(v).replace(/<[^>]*>/g,'').replace(/[<>"'`]/g,'').trim().slice(0,200); }
// [SECURITY] Sanitize notes; strip scripts and event handler attributes
function sNotes(v)    { if(!v)return ''; return String(v).replace(/<script[\s\S]*?<\/script>/gi,'').replace(/<[^>]*>/g,'').replace(/javascript:/gi,'').replace(/on\w+\s*=/gi,'').trim().slice(0,1000); }
// [SECURITY] Parse Rupiah string to safe non-negative integer
function sRp(v)       { if(v===null||v===undefined||v==='')return 0; var n=Math.floor(parseFloat(String(v).replace(/[^\d.]/g,''))); return isNaN(n)?0:Math.max(0,n); }
// [VALIDATION] Validate date string as yyyy-MM-dd; return empty if invalid
function sDate(v)     { if(!v)return ''; var s=String(v).trim(); if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return ''; if(isNaN(new Date(s+'T00:00:00').getTime()))return ''; return s; }

// [CALC] Derive total, remaining, overpayment, and status from raw amounts including penalty
function buildDebt(principal,interest,paidSoFar,penaltyTotal) {
  var p=Math.max(0,Math.floor(+principal||0));
  var i=Math.max(0,Math.floor(+interest ||0));
  var pen=Math.max(0,Math.floor(+penaltyTotal||0));
  var t=p+i+pen;
  var pd=Math.max(0,Math.floor(+paidSoFar||0));
  var rm=Math.max(0,t-pd);
  var ov=pd>t?pd-t:0;
  return { principal:p, interest:i, penalty:pen, total:t, paid:pd, remaining:rm, overpayment:ov, status:rm===0?'paid':'active' };
}

// [DB] Map raw sheet row array to debt object
function rToDebt(row) {
  var n=row.length;
  var archIdx = DC.hasOwnProperty('archived') ? DC.archived : -1;
  return {
    id:                 sStr(row[DC.id],50),
    person_name:        sStr(row[DC.person_name],200),
    principal_amount:   Math.max(0,Math.floor(+row[DC.principal_amount]||0)),
    interest_amount:    Math.max(0,Math.floor(+row[DC.interest_amount] ||0)),
    total_amount:       Math.max(0,Math.floor(+row[DC.total_amount]    ||0)),
    paid_amount:        Math.max(0,Math.floor(+row[DC.paid_amount]     ||0)),
    remaining_amount:   Math.max(0,Math.floor(+row[DC.remaining_amount]||0)),
    overpayment_amount: n>DC.overpayment_amount ? Math.max(0,Math.floor(+row[DC.overpayment_amount]||0)) : 0,
    status:             sStr(row[DC.status],20)||'active',
    due_date:           fmtDate(row[DC.due_date]),
    created_at:         n>DC.created_at  ? fmtDT(row[DC.created_at])  : '',
    notes:              n>DC.notes       ? sNotes(row[DC.notes])       : '',
    updated_at:         n>DC.updated_at  ? fmtDT(row[DC.updated_at])  : '',
    archived:           archIdx >= 0 && n > archIdx ? (String(row[archIdx]).toLowerCase() === 'true') : false,
    penalty_total:      n > DC.penalty_total ? Math.max(0,Math.floor(+row[DC.penalty_total]||0)) : 0
  };
}

// [DB] Map raw sheet row array to installment object
function rToInst(row) {
  return {
    id:             sStr(row[IC.id],50),
    debt_id:        sStr(row[IC.debt_id],50),
    payment_amount: Math.max(0,Math.floor(+row[IC.payment_amount]||0)),
    payment_date:   fmtDate(row[IC.payment_date]),
    created_at:     row.length>IC.created_at ? fmtDT(row[IC.created_at]) : '',
    notes:          row.length>IC.notes ? sNotes(row[IC.notes]) : '',
    penalty_amount: row.length>IC.penalty_amount ? Math.max(0,Math.floor(+row[IC.penalty_amount]||0)) : 0
  };
}

// [PERF] Read value from script cache
function cGet(k)     { try{var v=CacheService.getScriptCache().get(k);return v?JSON.parse(v):null;}catch(e){return null;} }
// [PERF] Write value to script cache with TTL
function cSet(k,v,t) { try{CacheService.getScriptCache().put(k,JSON.stringify(v),t||CACHE_TTL);}catch(e){} }
// [PERF] Invalidate debts cache on any write operation
function invalidateCache() { try{CacheService.getScriptCache().remove(CACHE_KEY);}catch(e){} }

// [UTIL] Acquire exclusive script lock or throw on timeout
function acquireLock() {
  var lock=LockService.getScriptLock();
  try{lock.waitLock(LOCK_MS);return lock;}
  catch(e){throw new Error('Sistem sedang sibuk, coba lagi sebentar. ('+e.message+')');}
}
// [UTIL] Release lock safely; ignores errors
function releaseLock(lock) { try{if(lock)lock.releaseLock();}catch(e){} }

// [CALC] Return zeroed summary object
function defSummary() {
  return { totalHutang:0, totalPaid:0, totalSisa:0, totalOverpayment:0, aktif:0, lunas:0, total:0, archived:0 };
}

// [API] Fetch debts with optional search, pagination, and archive filter
function getDebts(params) {
  try {
    if(params.id) return _getSingle(sStr(String(params.id),50));
    var page     = Math.max(1,parseInt(params.page, 10)||1);
    var limit    = Math.min(200,Math.max(1,parseInt(params.limit,10)||100));
    var q        = sStr(params.q||'',100).toLowerCase();
    var onlyArch = params.onlyArchived   === true || params.onlyArchived   === 'true';
    var inclArch = params.includeArchived === true || params.includeArchived === 'true';
    if(!q && !onlyArch){ var hit=cGet(CACHE_KEY); if(hit){ logInfo('cache hit'); return _page(hit,page,limit,'',onlyArch,inclArch); } }
    var sh=getOrCreateSheet(SHEET_DEBTS), lr=sh.getLastRow();
    if(lr<=1) return {success:true,data:[],total:0,page:page,limit:limit,summary:defSummary()};
    var raw=sh.getRange(1,1,lr,sh.getLastColumn()).getValues();
    var all=[];
    for(var r=1;r<raw.length;r++){if(raw[r][DC.id]){var _d=rToDebt(raw[r]);_d._rowIdx=r;all.push(_d);}}
    all.reverse();
    if(!q && !onlyArch) cSet(CACHE_KEY,all);
    return _page(all,page,limit,q,onlyArch,inclArch);
  } catch(err){ logError('getDebts',err); return {success:false,message:err.message,data:[],total:0,summary:defSummary()}; }
}

// [CALC] Filter, paginate, and compute summary from debt list
function _page(all,page,limit,q,onlyArch,inclArch) {
  var base = onlyArch ? all.filter(function(d){ return !!d.archived; })
           : inclArch ? all
           :            all.filter(function(d){ return !d.archived; });
  var list = q ? base.filter(function(d){
    return (d.person_name||'').toLowerCase().indexOf(q)!==-1||
           (d.notes||'').toLowerCase().indexOf(q)!==-1||
           (d.status||'').indexOf(q)!==-1;
  }) : base;
  list = list.slice().sort(function(a, b) { return (b._rowIdx || 0) - (a._rowIdx || 0); });
  var total=list.length, start=(page-1)*limit;
  var slice=list.slice(start,start+limit);
  var activeSrc = all.filter(function(d){ return !d.archived; });
  var s = defSummary();
  s.archived = all.filter(function(d){ return !!d.archived; }).length;
  activeSrc.forEach(function(d){
    s.totalHutang      +=d.total_amount       ||0;
    s.totalPaid        +=d.paid_amount        ||0;
    s.totalSisa        +=d.remaining_amount   ||0;
    s.totalOverpayment +=d.overpayment_amount ||0;
    d.status==='paid'?s.lunas++:s.aktif++;
  });
  s.total = s.aktif + s.lunas;
  return {success:true,data:slice,total:total,page:page,limit:limit,summary:s};
}

// [DB] Fetch single debt row with its installment history
function _getSingle(id) {
  try {
    var sh=getOrCreateSheet(SHEET_DEBTS), lr=sh.getLastRow();
    if(lr<=1) return {success:false,message:'Data tidak ditemukan'};
    var raw=sh.getRange(1,1,lr,sh.getLastColumn()).getValues();
    var debt=null;
    for(var r=1;r<raw.length;r++){if(String(raw[r][DC.id])===id){debt=rToDebt(raw[r]);break;}}
    if(!debt) return {success:false,message:'Debt tidak ditemukan: '+id};
    var ish=getOrCreateSheet(SHEET_INST), ilr=ish.getLastRow(), insts=[];
    if(ilr>1){
      var ir=ish.getRange(1,1,ilr,ish.getLastColumn()).getValues();
      for(var i=1;i<ir.length;i++){if(String(ir[i][IC.debt_id])===id)insts.push(rToInst(ir[i]));}
    }
    return {success:true,data:debt,installments:insts};
  } catch(err){ logError('_getSingle:'+id,err); return {success:false,message:err.message}; }
}

// [API] Create new debt record with validation
function createDebt(params) {
  var lock=acquireLock();
  try {
    // [REFACTOR] Use validation helpers
    var name  = _requireName(params.person_name);
    var prin  = _requirePositiveAmount(params.principal_amount, 'Pokok pinjaman');
    var inter = sRp(params.interest_amount);
    var due   = sDate(params.due_date);
    var notes = sNotes(params.notes);
    
    var c=buildDebt(prin,inter,0);
    var sh=getOrCreateSheet(SHEET_DEBTS);
    var id=genDebtId(sh), now=nowWIB();
    var row=new Array(DEBT_HEADERS.length).fill('');
    row[DC.id]=id; row[DC.person_name]=name;
    row[DC.principal_amount]=c.principal; row[DC.interest_amount]=c.interest;
    row[DC.total_amount]=c.total; row[DC.paid_amount]=0;
    row[DC.remaining_amount]=c.total; row[DC.overpayment_amount]=0;
    row[DC.status]='active'; row[DC.due_date]=due;
    row[DC.created_at]=now; row[DC.notes]=notes; row[DC.updated_at]=now;
    row[DC.penalty_total]=0;
    sh.appendRow(row); invalidateCache();
    logInfo('createDebt OK: '+id);
    return {success:true,data:{id:id,person_name:name,principal_amount:c.principal,interest_amount:c.interest,
      total_amount:c.total,paid_amount:0,remaining_amount:c.total,overpayment_amount:0,
      status:'active',due_date:due,created_at:now,notes:notes,updated_at:now}};
  } catch(err){ logError('createDebt',err); return {success:false,message:err.message}; }
  finally{ releaseLock(lock); }
}

// [API] Update debt fields and recalculate derived values
function updateDebt(params) {
  var lock=acquireLock();
  try {
    // [REFACTOR] Use helper functions
    var id = _requireId(params);
    var sh = getOrCreateSheet(SHEET_DEBTS);
    var found = _findDebtRow(sh, id);
    var ex = found.row;
    var rowNum = found.rowNum;
    var nc = sh.getLastColumn();
    
    // [REFACTOR] Cleaner parameter extraction
    var name  = params.person_name      !== undefined ? _requireName(params.person_name) : sStr(ex[DC.person_name],200);
    var prin  = params.principal_amount !== undefined ? _requirePositiveAmount(params.principal_amount, 'Pokok') : Math.max(0,Math.floor(+ex[DC.principal_amount]||0));
    var inter = params.interest_amount  !== undefined ? sRp(params.interest_amount) : Math.max(0,Math.floor(+ex[DC.interest_amount]||0));
    var due   = params.due_date         !== undefined ? sDate(params.due_date) : fmtDate(ex[DC.due_date]);
    var notes = params.notes            !== undefined ? sNotes(params.notes) : (ex.length>DC.notes?sNotes(ex[DC.notes]):'');
    
    var paid = Math.max(0,Math.floor(+ex[DC.paid_amount]||0));
    var c = buildDebt(prin,inter,paid), now = nowWIB();
    var vals = found.allRows[rowNum-1].slice();
    while(vals.length<DEBT_HEADERS.length)vals.push('');
    vals[DC.person_name]=name; vals[DC.principal_amount]=c.principal; vals[DC.interest_amount]=c.interest;
    vals[DC.total_amount]=c.total; vals[DC.paid_amount]=c.paid; vals[DC.remaining_amount]=c.remaining;
    vals[DC.overpayment_amount]=c.overpayment; vals[DC.status]=c.status;
    vals[DC.due_date]=due; vals[DC.notes]=notes; vals[DC.updated_at]=now;
    sh.getRange(rowNum,1,1,nc).setValues([vals]); invalidateCache();
    logInfo('updateDebt OK: '+id);
    return {success:true,data:{id:id,person_name:name,principal_amount:c.principal,interest_amount:c.interest,
      total_amount:c.total,paid_amount:c.paid,remaining_amount:c.remaining,overpayment_amount:c.overpayment,
      status:c.status,due_date:due,created_at:ex.length>DC.created_at?fmtDT(ex[DC.created_at]):'',notes:notes,updated_at:now}};
  } catch(err){ logError('updateDebt',err); return {success:false,message:err.message}; }
  finally{ releaseLock(lock); }
}

// [API] Delete debt row and all associated installments atomically
function deleteDebt(params) {
  var lock=acquireLock();
  try {
    if(!params.id) throw new Error('id diperlukan');
    var id=sStr(String(params.id),50);
    var dsh=getOrCreateSheet(SHEET_DEBTS), dlr=dsh.getLastRow();
    if(dlr<=1) throw new Error('Debt tidak ditemukan: '+id);
    var idcol=dsh.getRange(1,1,dlr,1).getValues(); var rowNum=-1;
    for(var r=idcol.length-1;r>=1;r--){if(String(idcol[r][0])===id){rowNum=r+1;break;}}
    if(rowNum===-1) throw new Error('Debt tidak ditemukan: '+id);
    dsh.deleteRow(rowNum);
    var ish=getOrCreateSheet(SHEET_INST), ilr=ish.getLastRow();
    if(ilr>1){
      var icol=ish.getRange(1,2,ilr,1).getValues(); var dels=[];
      for(var i=1;i<icol.length;i++){if(String(icol[i][0])===id)dels.push(i+1);}
      for(var j=dels.length-1;j>=0;j--){if(dels[j]>=2)ish.deleteRow(dels[j]);}
    }
    invalidateCache();
    logInfo('deleteDebt OK: '+id);
    return {success:true,deleted_id:id};
  } catch(err){
    logError('deleteDebt',err);
    return {success:false,message:err.message};
  } finally{ releaseLock(lock); }
}

// [API] Record payment installment with optional penalty and notes; recalculates debt totals
function addPayment(params) {
  var lock=acquireLock(); var newInstId=null;
  try {
    var debtId =sStr(params.debt_id,50);
    var amount =sRp(params.payment_amount);
    var date   =sDate(params.payment_date)||todayWIB();
    var notes  =sNotes(params.notes||'');
    if(!debtId)   throw new Error('debt_id diperlukan');
    if(amount<=0) throw new Error('Jumlah pembayaran harus lebih dari 0');
    var dsh=getOrCreateSheet(SHEET_DEBTS), dlr=dsh.getLastRow();
    if(dlr<=1) throw new Error('Debt tidak ditemukan: '+debtId);
    var idcol=dsh.getRange(1,1,dlr,1).getValues(); var found=false;
    for(var r=1;r<idcol.length;r++){if(String(idcol[r][0])===debtId){found=true;break;}}
    if(!found) throw new Error('Debt tidak ditemukan: '+debtId);
    var ish=getOrCreateSheet(SHEET_INST);
    var iid=genInstId(ish), now=nowWIB();
    var irow=new Array(INST_HEADERS.length).fill('');
    irow[IC.id]=iid; irow[IC.debt_id]=debtId; irow[IC.payment_amount]=amount;
    irow[IC.payment_date]=date; irow[IC.created_at]=now; irow[IC.notes]=notes;
    ish.appendRow(irow); newInstId=iid;
    invalidateCache();
    var res=_recalc(debtId,dsh);
    if(!res.success) throw new Error('Recalculate gagal: '+(res.message||''));
    newInstId=null;
    logInfo('addPayment OK: '+debtId+' Rp'+amount);
    return res;
  } catch(err){
    logError('addPayment',err);
    if(newInstId){
      try{
        var rish=getOrCreateSheet(SHEET_INST), rlr=rish.getLastRow();
        var rcol=rish.getRange(1,1,rlr,1).getValues();
        for(var k=rcol.length-1;k>=1;k--){if(String(rcol[k][0])===newInstId){rish.deleteRow(k+1);break;}}
      } catch(re){ logError('addPayment rollback FAILED',re); }
    }
    return {success:false,message:err.message};
  } finally{ releaseLock(lock); }
}

// [CALC] Sum all installments (payment + penalty) for a debt and write recalculated fields back to sheet
function _recalc(debtId,dsh) {
  debtId=sStr(String(debtId),50);
  try {
    var ish=getOrCreateSheet(SHEET_INST), ilr=ish.getLastRow(), totalPaid=0;
    if(ilr>1){
      var ncInst=ish.getLastColumn();
      var iraw=ish.getRange(1,1,ilr,ncInst).getValues();
      for(var i=1;i<iraw.length;i++){
        if(String(iraw[i][IC.debt_id])===debtId){
          totalPaid+=Math.max(0,Math.floor(+iraw[i][IC.payment_amount]||0));
          totalPaid+=Math.max(0,Math.floor(+iraw[i][IC.penalty_amount]||0));
        }
      }
    }
    if(!dsh)dsh=getOrCreateSheet(SHEET_DEBTS);
    var dlr=dsh.getLastRow();
    if(dlr<=1) return {success:false,message:'Debt tidak ditemukan: '+debtId};
    var nc=dsh.getLastColumn();
    var draw=dsh.getRange(1,1,dlr,nc).getValues();
    for(var r=1;r<draw.length;r++){
      if(String(draw[r][DC.id])!==debtId)continue;
      var prin=Math.max(0,Math.floor(+draw[r][DC.principal_amount]||0));
      var inter=Math.max(0,Math.floor(+draw[r][DC.interest_amount] ||0));
      var penTot=draw[r].length>DC.penalty_total?Math.max(0,Math.floor(+draw[r][DC.penalty_total]||0)):0;
      var c=buildDebt(prin,inter,totalPaid,penTot), now=nowWIB();
      var vals=draw[r].slice();
      while(vals.length<DEBT_HEADERS.length)vals.push('');
      vals[DC.total_amount]=c.total; vals[DC.paid_amount]=c.paid;
      vals[DC.remaining_amount]=c.remaining; vals[DC.overpayment_amount]=c.overpayment;
      vals[DC.status]=c.status; vals[DC.updated_at]=now;
      // [BUG FIX] Use actual vals length, not stale nc, to avoid truncating new columns
      var writeNc = Math.max(nc, vals.length);
      dsh.getRange(r+1,1,1,writeNc).setValues([vals]);
      return {success:true,data:{
        id:debtId, person_name:sStr(draw[r][DC.person_name],200),
        principal_amount:prin, interest_amount:inter,
        penalty_total:penTot,
        total_amount:c.total, paid_amount:c.paid, remaining_amount:c.remaining,
        overpayment_amount:c.overpayment, status:c.status,
        due_date:fmtDate(draw[r][DC.due_date]),
        created_at:draw[r].length>DC.created_at?fmtDT(draw[r][DC.created_at]):'',
        notes:draw[r].length>DC.notes?sNotes(draw[r][DC.notes]):'',
        updated_at:now
      }};
    }
    return {success:false,message:'Debt tidak ditemukan (recalc): '+debtId};
  } catch(err){ logError('_recalc',err); return {success:false,message:err.message}; }
}


// [API] Add penalty amount to debt total; increases total_amount and recalculates
function addPenalty(params) {
  var lock = acquireLock();
  try {
    if (!params.id) throw new Error('id diperlukan');
    var id      = sStr(String(params.id), 50);
    var penalty = sRp(params.penalty_amount);
    if (penalty <= 0) throw new Error('Jumlah denda harus lebih dari 0');
    var sh = getOrCreateSheet(SHEET_DEBTS), lr = sh.getLastRow();
    if (lr <= 1) throw new Error('Debt tidak ditemukan: ' + id);
    var nc  = sh.getLastColumn();
    var raw = sh.getRange(1, 1, lr, nc).getValues();
    var rowNum = -1;
    for (var r = 1; r < raw.length; r++) {
      if (String(raw[r][DC.id]) === id) { rowNum = r + 1; break; }
    }
    if (rowNum === -1) throw new Error('Debt tidak ditemukan: ' + id);
    var row     = raw[rowNum - 1].slice();
    var prin    = Math.max(0, Math.floor(+row[DC.principal_amount] || 0));
    var inter   = Math.max(0, Math.floor(+row[DC.interest_amount]  || 0));
    var oldPen  = row.length > DC.penalty_total ? Math.max(0, Math.floor(+row[DC.penalty_total] || 0)) : 0;
    var paid    = Math.max(0, Math.floor(+row[DC.paid_amount] || 0));
    var newPen  = oldPen + penalty;
    while (row.length < DEBT_HEADERS.length) row.push('');
    row[DC.penalty_total] = newPen;
    row[DC.updated_at]    = nowWIB();
    // [BUG FIX] Build recalculated values first, then write ONCE with all fields updated
    var c = buildDebt(prin, inter, paid, newPen);
    row[DC.total_amount]       = c.total;
    row[DC.remaining_amount]   = c.remaining;
    row[DC.overpayment_amount] = c.overpayment;
    row[DC.status]             = c.status;
    sh.getRange(rowNum, 1, 1, Math.max(nc, DEBT_HEADERS.length)).setValues([row]);
    invalidateCache();
    logInfo('addPenalty OK: ' + id + ' +Rp' + penalty + ' (total denda: Rp' + newPen + ')');
    return { success: true, data: rToDebt(row) };
  } catch(err) { logError('addPenalty', err); return { success: false, message: err.message }; }
  finally { releaseLock(lock); }
}

// [API] Set archived=true on a paid debt; excludes it from dashboard
function archiveDebt(params) {
  var lock = acquireLock();
  try {
    if (!params.id) throw new Error('id diperlukan');
    var id = sStr(String(params.id), 50);
    var sh = getOrCreateSheet(SHEET_DEBTS), lr = sh.getLastRow();
    if (lr <= 1) throw new Error('Debt tidak ditemukan: ' + id);
    var nc = sh.getLastColumn();
    var raw = sh.getRange(1, 1, lr, nc).getValues();
    var rowNum = -1;
    for (var r = 1; r < raw.length; r++) {
      if (String(raw[r][DC.id]) === id) { rowNum = r + 1; break; }
    }
    if (rowNum === -1) throw new Error('Debt tidak ditemukan: ' + id);
    if (sStr(raw[rowNum-1][DC.status], 20) !== 'paid') throw new Error('Hanya transaksi lunas yang bisa di-archive');
    var vals = raw[rowNum-1].slice();
    while (vals.length < DC.archived + 1) vals.push('');
    vals[DC.archived] = true;
    vals[DC.updated_at] = nowWIB();
    sh.getRange(rowNum, 1, 1, Math.max(nc, DC.archived + 1)).setValues([vals]);
    invalidateCache();
    logInfo('archiveDebt OK: ' + id);
    return { success: true, data: rToDebt(vals) };
  } catch(err) { logError('archiveDebt', err); return { success: false, message: err.message }; }
  finally { releaseLock(lock); }
}

// [API] Set archived=false on a debt; restores it to the active dashboard
function unarchiveDebt(params) {
  var lock = acquireLock();
  try {
    if (!params.id) throw new Error('id diperlukan');
    var id = sStr(String(params.id), 50);
    var sh = getOrCreateSheet(SHEET_DEBTS), lr = sh.getLastRow();
    if (lr <= 1) throw new Error('Debt tidak ditemukan: ' + id);
    var nc = sh.getLastColumn();
    var raw = sh.getRange(1, 1, lr, nc).getValues();
    var rowNum = -1;
    for (var r = 1; r < raw.length; r++) {
      if (String(raw[r][DC.id]) === id) { rowNum = r + 1; break; }
    }
    if (rowNum === -1) throw new Error('Debt tidak ditemukan: ' + id);
    var vals = raw[rowNum-1].slice();
    while (vals.length < DC.archived + 1) vals.push('');
    vals[DC.archived] = false;
    vals[DC.updated_at] = nowWIB();
    sh.getRange(rowNum, 1, 1, Math.max(nc, DC.archived + 1)).setValues([vals]);
    invalidateCache();
    logInfo('unarchiveDebt OK: ' + id);
    return { success: true, data: rToDebt(vals) };
  } catch(err) { logError('unarchiveDebt', err); return { success: false, message: err.message }; }
  finally { releaseLock(lock); }
}