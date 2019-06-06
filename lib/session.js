// LICENSE_CODE ZON ISC
'use strict'; /*jslint node:true, esnext:true, evil: true*/
const _ = require('lodash');
const events = require('events');
const date = require('../util/date.js');
const etask = require('../util/etask.js');
const url = require('url');
const util = require('util');
const username = require('./username.js');
const zerr = require('../util/zerr.js');
const qw = require('../util/string.js').qw;
const request = require('request');
const Timeline = require('./timeline.js');
const lpm_config = require('../util/lpm_config.js');
const assign = Object.assign, {SEC, HOUR} = date.ms;
const E = module.exports;

E.pool_types = {
    default: 0,
    long_availability: 1,
};
class Session_pool {
    constructor(key, name){
        this.key = key;
        this.name = name;
        this.sessions = [];
    }
    _insert(sess){ this.sessions.push(sess); }
    add(sess, session_mgr){
        if (sess.pool_keys && sess.pool_keys.has(this.key))
            return;
        zerr.info(`add session ${sess.session} to ${this.name} pool`);
        this._insert(sess);
        sess.pool_keys = sess.pool_keys||new Set();
        sess.pool_keys.add(this.key);
        session_mgr.sp.spawn(session_mgr.set_keep_alive(sess));
        return true;
    }
    get(){}
    _remove(sess){ _.remove(this.sessions, sess); }
    remove(sess, session_mgr){
        if (!sess.pool_keys || !sess.pool_keys.has(this.key))
            return;
        zerr.info(`delete session ${sess.session} from ${this.name} pool`);
        this._remove(sess);
        session_mgr.stop_keep_alive(sess);
        sess.pool_keys.delete(this.key);
    }
}
E.Session_pool = Session_pool;

class Reserve_session_pool extends Session_pool {
    constructor(key){ super(key, 'reserve'); }
    get(){
        const sess = this.sessions.shift();
        if (!sess)
            return void zerr.info(`no sessions in reserve pool`);
        this.sessions.push(sess);
        zerr.info(`get session ${sess.session} reserve pool`);
        return sess;
    }
}
E.Reserve_session_pool = Reserve_session_pool;

class Fast_session_pool extends Session_pool {
    constructor(key, size){
        super(key, 'fast');
        this.size = size||10;
        this.index = 0;
        this.direction = this.size>1 ? 1 : 0;
    }
    inc_index(){
        this.index = this.index+this.direction;
        if (this.index===0 || this.index==this.size-1)
            this.direction = -this.direction;
    }
    _insert(sess){
        this.sessions[this.index] = sess;
        this.inc_index();
    }
    get(){
        const sess = this.sessions[this.index];
        if (!sess)
            return;
        this.inc_index();
        zerr.info(`get session ${sess.session} from fast pool`);
        return sess;
    }
    _remove(sess){
        const i = this.sessions.indexOf(sess);
        if (i>=0)
            this.sessions[i] = undefined;
    }
}

const send_sessions_ui = function(){
    if (!this.lum.mgr.wss || !this.sessions)
        return;
    this.lum.mgr.wss.broadcast({
        payload: this.sessions.sessions.map(this.serialize_session),
        path: 'sessions.'+this.lum.port,
    }, 'global');
};

function Sess_mgr(lum, opt){
    events.EventEmitter.call(this);
    this.send_sessions_ui = _.throttle(send_sessions_ui.bind(this), 200);
    this.opt = opt;
    this.log = lum.log;
    this.lum = lum;
    this.session_pools = new Map();
    this.setMaxListeners(Number.MAX_SAFE_INTEGER);
    if (opt.session_duration)
        this.session_duration = opt.session_duration*SEC;
    this.pool_type = E.pool_types[opt.pool_type] || E.pool_types.default;
    this.session_id = 1;
    this.sticky_sessions = {};
    if (opt.session!==true && opt.session)
        opt.pool_size = 1;
    if (Number(opt.keep_alive)===opt.keep_alive)
        this.keep_alive = opt.keep_alive;
    else
    {
        this.keep_alive = !!((opt.pool_size || opt.sticky_ip) &&
            !this.opt.static);
    }
    this.seed = opt.seed ||
        Math.ceil(Math.random()*Number.MAX_SAFE_INTEGER).toString(16);
    this.reset_idle_pool();
}

util.inherits(Sess_mgr, events.EventEmitter);

Sess_mgr.prototype.start = function(){
    this.sp = etask(function*sesssion_manager(){ yield this.wait(); });
};

Sess_mgr.prototype.get_reserved_sessions = function(){
    const r_sess_pool = this.session_pools.get('reserve_session');
    return r_sess_pool && r_sess_pool.sessions || [];
};

Sess_mgr.prototype.get_fast_sessions = function(regex){
    const r_sess_pool = this.session_pools.get('fast_pool:'+regex);
    return (r_sess_pool && r_sess_pool.sessions || []).filter(Boolean);
};

Sess_mgr.prototype.add_fast_pool_session = function(session, pool_key, size){
    if (!session || !pool_key)
        return;
    const s_pool = this.session_pools.get(pool_key)
        || new Fast_session_pool(pool_key, size);
    s_pool.add(session, this);
    this.session_pools.set(s_pool.key, s_pool);
};

Sess_mgr.prototype.add_to_pool = function(session={}){
    if (!this.sessions)
        this.sessions = {sessions: [], pool_ready: true};
    const ip = session.ip || session.last_res && session.last_res.ip;
    if (!ip || this.sessions.sessions.length>=this.opt.pool_size)
        return;
    const curr_ips = this.sessions.sessions
        .map(s=>s.ip || s.last_res && s.last_res.ip);
    if (curr_ips.includes(ip))
        return;
    if (this.sessions.sessions.map(s=>s.session).includes(session.session))
        return;
    this.sessions.sessions.push(session);
    this.send_sessions_ui();
    const proxy = this.lum.mgr.proxies.find(p=>p.port==this.lum.port);
    if (!this.opt.static || (proxy.ips||[]).includes(ip))
        return;
    session.ip = ip;
    if (!proxy.ips || !this.opt.ips)
        proxy.ips = this.opt.ips = [];
    proxy.ips.push(ip);
    this.lum.mgr.save_config();
};

Sess_mgr.prototype.add_reserve_pool_session = function(session, pool_key){
    if (!session || !pool_key)
        return;
    const s_pool = this.session_pools.get(pool_key)
        || new Reserve_session_pool(pool_key);
    s_pool.add(session, this);
    this.session_pools.set(s_pool.key, s_pool);
};

Sess_mgr.prototype.remove_session_from_pool = function(session, pool_key){
    const s_pool = this.session_pools.get(pool_key);
    if (!session || !s_pool)
        return;
    s_pool.remove(session, this);
};

Sess_mgr.prototype.calculate_username = function(opt){
    if (!opt.password)
        delete opt.password;
    opt = assign.apply({}, [this.opt, this, opt].map(o=>_.pick(o||{},
        qw`customer zone country state city session asn dns cid ip raw direct
        debug password mobile vip carrier ext_proxy route_err mobile`)));
    if (opt.ext_proxy)
    {
        return Object.assign({password: opt.password},
            _.pick(opt.ext_proxy, 'username', 'password'));
    }
    let opt_usr = _.omit(opt, qw`password`);
    if (opt_usr.ip)
        opt_usr = _.omit(opt_usr, qw`session`);
    return {username: username.calc(opt_usr, this.opt.short_username),
        password: opt.password};
};

Sess_mgr.prototype.refresh_sessions = function(){
    this.log.notice('Refreshing all sessions');
    this.emit('refresh_sessions');
    if (this.opt.pool_size && this.sessions)
    {
        this.stop_keep_alive(this.sessions.sessions.shift());
        this.pool_fetch();
    }
    if (this.opt.sticky_ip)
    {
        this.sticky_sessions.canceled = true;
        this.sticky_sessions = {};
    }
    if (this.opt.session==true && this.session)
    {
        this.stop_keep_alive(this.session);
        this.session = null;
    }
};

Sess_mgr.prototype.establish_session = function(prefix, pool, opt={}){
    let session_id, ips, ip, vips, vip, cred, host;
    let ext_proxy, ext_proxies, proxy_port;
    if (pool && pool.canceled || this.stopped)
        return;
    const init_ips_pool = opt.init && this.opt.ips && this.opt.ips.length;
    ips = (init_ips_pool || this.is_using_pool()) && this.opt.ips || [];
    vips = this.opt.vips||[];
    ext_proxies = this.opt.ext_proxies||[];
    if (this.opt.session!==true && this.opt.session)
        session_id = this.opt.session;
    else
        session_id = `${prefix}_${this.session_id++}`;
    ext_proxy = ext_proxies[this.session_id%ext_proxies.length];
    if (ext_proxy)
    {
        ext_proxy = parse_proxy_string(ext_proxy, {
            username: this.opt.ext_proxy_username,
            password: this.opt.ext_proxy_password,
            port: this.opt.ext_proxy_port,
        });
        host = ext_proxy.host;
        proxy_port = ext_proxy.port;
    }
    else
    {
        host = this.lum.hosts.shift();
        this.lum.hosts.push(host);
        vip = vips[this.session_id%vips.length];
        ip = ips[this.session_id%ips.length];
    }
    cred = this.calculate_username({ip, session: session_id, vip, ext_proxy});
    const now = Date.now();
    const session = {
        host,
        session: session_id,
        ip,
        vip,
        ext_proxy,
        count: 0,
        created: now,
        username: cred.username,
        pool,
        proxy_port,
    };
    if (this.session_duration)
        session.expire = now+this.session_duration;
    if (this.opt.max_requests)
        session.max_requests = this.opt.max_requests;
    this.log.info('new session added %s:%s', host, session_id);
    return session;
};

Sess_mgr.prototype.pool_fetch = function(opt={}){
    try {
        if (opt.immediate===undefined)
            opt.immediate = true;
        const session = this.establish_session(
            `${this.lum.port}_${this.seed}`, this.sessions, opt);
        if (session)
        {
            this.sessions.sessions.push(session);
            this.send_sessions_ui();
            this.sp.spawn(this.set_keep_alive(session, opt));
        }
    } catch(e){
        this.log.error(zerr.e2s(e));
    }
};

Sess_mgr.prototype.pool = function(count, opt){
    if (!count)
        return;
    for (let i=0; i<count; i++)
        this.pool_fetch(opt);
    this.pool_ready = true;
};

Sess_mgr.prototype.reset_idle_pool = function(){
    const offset = Number.isInteger(this.opt.idle_pool) ?
        this.opt.idle_pool : HOUR;
    this.idle_date = +date()+offset;
};

Sess_mgr.prototype.set_keep_alive = etask._fn(
function*set_keep_alive(_this, session, opt={}){
    try {
        if (!_this.keep_alive)
            return;
        _this.stop_keep_alive(session);
        session.keep_alive = this;
        const keep_alive_sec = _this.keep_alive===true ? 45 : _this.keep_alive;
        if (!opt.immediate)
            yield etask.sleep(keep_alive_sec*SEC);
        let idle = false;
        while (!idle && session.keep_alive && session.keep_alive==this)
        {
            yield _this.keep_alive_handler(session);
            yield etask.sleep(keep_alive_sec*SEC);
            idle = _this.opt.idle_pool && +date()>_this.idle_date;
        }
        _this.log.warn('session %s: keep alive ended', session.session);
    } catch(e){
        _this.log.error(zerr.e2s(e));
    }
});

Sess_mgr.prototype.keep_alive_handler = etask._fn(
function*keep_alive_handler(_this, session){
    // XXX krzysztof: double check if this is needed. why not removing session
    if ((!session.pool_keys || !session.pool_keys.size)
        && _this.is_session_expired(session) || _this.lum.stopped)
    {
        return;
    }
    _this.log.info('Keep alive %s:%s', session.host, session.session);
    const res = yield _this.info_request(session, 'SESSION KEEP ALIVE');
    const proxy_err = _this.lum._check_proxy_response(session.host, res,
        {from: 'keep alive', error: res.err});
    let err;
    const curr_ips = _this.sessions &&
        _this.sessions.sessions.map(s=>s.info && s.info.ip) || [];
    const this_ip = session.info && session.info.ip;
    if (proxy_err || res.err || !res.info)
        err = 'keep alive failed';
    else if (res.info.ip!=this_ip && curr_ips.includes(res.info.ip))
        err = `IP ${res.info.ip} already in the pool`;
    else if (_this.lum.is_ip_banned(res.info.ip))
        err = `IP ${res.info.ip} is banned`;
    if (err)
        return _this.replace_session(session, err);
    if (_this.opt.smtp_test)
    {
        const test_res = yield _this.smtp_test(session);
        if (test_res!==true)
        {
            _this.lum.banip(res.info.ip, 0);
            return _this.replace_session(session, test_res,
                {immediate: true});
        }
    }
    let sess_info = session.info;
    if (!sess_info || !sess_info.ip)
        sess_info = res.info;
    if (res.info.ip!=sess_info.ip)
    {
        _this.log.warn('session %s: ip change %s -> %s',
            session.session, sess_info.ip, res.info.ip);
    }
    session.info = res.info;
    session.last_res = {ts: Date.now(), ip: res.info.ip,
        session: session.session};
    _this.send_sessions_ui();
});

Sess_mgr.prototype.replace_session = function(session, err, opt={}){
    this.log.warn('removing session %s: %s', session.session, err);
    this.remove_session(session);
    if (this.opt.pool_size && this.opt.pool_prefill)
        this.pool_fetch(Object.assign({immediate: false}, opt));
};

Sess_mgr.prototype.serialize_session = function(session){
    return {
        session: session.session,
        ip: session.ip || session.last_res && session.last_res.ip,
        host: session.host,
        username: session.username,
        created: session.created,
    };
};

Sess_mgr.prototype.get_sessions = function(){
    return (this.sessions && this.sessions.sessions || []).reduce((acc, s)=>
        Object.assign({}, acc, {[s.session]: this.serialize_session(s)}), {});
};

Sess_mgr.prototype.remove_session = function(session){
    session.canceled = true;
    this.stop_keep_alive(session);
    for (let [, s_pool] of this.session_pools)
        s_pool.remove(session, this);
    if (!session.pool)
        return;
    const sessions = _.isArray(session.pool) ? session.pool :
        session.pool.sessions;
    _.remove(sessions, s=>s===session);
    if (this.opt.ips && this.opt.ips.includes(session.ip))
    {
        _.remove(this.opt.ips, ip=>ip==session.ip);
        this.lum.mgr.save_config();
    }
    this.send_sessions_ui();
};

Sess_mgr.prototype.stop_keep_alive = function(session){
    if (!session.keep_alive)
        return;
    session.keep_alive.return();
    session.keep_alive = null;
};

Sess_mgr.prototype.request_completed = function(session){
    if (!session || session.canceled || session.pool && session.pool.canceled)
        return true;
    if (!session.pool && session!=this.session
        && (!session.pool_keys || !session.pool_keys.size))
    {
        return this.stop_keep_alive(session);
    }
    this.sp.spawn(this.set_keep_alive(session));
};

Sess_mgr.prototype.is_session_banned = function(session){
    return session.last_res && this.lum.is_ip_banned(session.last_res.ip);
};

Sess_mgr.prototype.is_session_expired = function(session){
    if (!session || session.canceled || session.pool && session.pool.canceled)
        return true;
    const expired = session.max_requests && session.count>session.max_requests
        || session.expire && Date.now()>session.expire;
    if (expired && (!session.pool_keys || !session.pool_keys.size))
        this.stop_keep_alive(session);
    return expired;
};

Sess_mgr.prototype.smtp_test = etask._fn(
function*smtp_test(_this, session){
    this.on('uncaught', e=>{
        this.return(e);
    });
    const host = session.host || _this.lum.hosts[0];
    const {username, password} = _this.calculate_username(session);
    const auth = 'Basic '+
        Buffer.from(username+':'+password).toString('base64');
    const proxy = _this.lum.http.request({
        path: _this.opt.smtp_test,
        host,
        port: 8443,
        method: 'CONNECT',
        headers: {
            'proxy-authorization': auth,
            'x-hola-agent': lpm_config.hola_agent,
        },
        followRedirect: false,
    });
    proxy.end();
    proxy.setTimeout(30*SEC);
    proxy.on('error', err=>{
        this.throw('error');
    });
    proxy.on('timeout', ()=>{
        this.throw('timeout');
    });
    proxy.on('close', ()=>{
        // XXX krzysztof: ensure task closed
    });
    proxy.on('connect', (res, socket, head)=>{
        if (res.statusCode==200)
            return this.continue(socket);
        this.throw(res.statusMessage);
    });
    const socket = yield this.wait();
    socket.on('close', ()=>{
        this.throw('close');
    });
    socket.once('data', chunk=>{
        chunk = chunk.toString();
        if (chunk.startsWith('220'))
            return this.continue();
        this.throw(chunk);
    });
    yield this.wait();
    socket.write('ehlo .\r\n');
    socket.once('data', chunk=>{
        chunk = chunk.toString();
        if (chunk.startsWith('250'))
            return this.continue();
        this.throw(chunk);
    });
    socket.write('mail from:<contact@att.net>\r\n');
    yield this.wait();
    socket.once('data', chunk=>{
        chunk = chunk.toString();
        if (chunk.includes('Sender ok'))
            return this.continue(true);
        this.throw(chunk);
    });
    return yield this.wait();
});

Sess_mgr.prototype.info_request = etask._fn(
function*info_request(_this, session, context){
    const host = session.host || _this.lum.hosts[0];
    const cred = _this.calculate_username(session);
    const protocol = _this.opt.secure_proxy ? 'https' : 'http';
    const proxy_url = `${protocol}://${cred.username}:${cred.password}@${host}`
    +`:${_this.opt.proxy_port}`;
    const opt = {
        url: _this.opt.test_url,
        proxy: proxy_url,
        headers: {
            'x-hola-agent': lpm_config.hola_agent,
            host: 'zproxy.hola.org',
        },
        followRedirect: false,
    };
    const timeline = new Timeline();
    const res = {
        request: {
            method: 'GET',
            url: opt.url,
            headers: opt.headers,
            body: '',
        },
        timeline: timeline,
        context: context,
        body: '',
        proxy: {
            host: host,
            username: cred.username,
        },
    };
    let err, info;
    try {
        request(opt).on('response', _res=>{
            timeline.track('response');
            assign(res, {
                status_code: _res.statusCode,
                status_message: _res.statusMessage,
                headers: _res.headers,
                raw_headers: _res.rawHeaders,
            });
        }).on('data', data=>res.body+=data)
        .on('error', _err=>{
            err = _err;
            this.continue();
        }).on('end', ()=>{
            timeline.track('end');
            this.continue();
        }).on('finish', ()=>{
            timeline.track('end');
            this.continue();
        }).on('close', ()=>{
            timeline.track('end');
            this.continue();
        });
        const __this = this;
        let finished;
        _this.sp.spawn(etask(function*timeout_info_request(){
            yield etask.sleep(30*SEC);
            if (!finished)
                __this.continue();
        }));
        yield this.wait();
        finished = true;
        if (err)
            throw err;
        res.body_size = res.body.length;
        const ct = res.headers && res.headers['content-type'];
        if (res.status_code==200 && ct && ct.match(/\/json/))
            info = JSON.parse(res.body);
       _this.emit('response', res);
    } catch(e){
        err = e;
        res.status_code = 502;
        _this.log.warn('info_request '+zerr.e2s(err));
    }
    return {res, err, info};
});

Sess_mgr.prototype.request_session = function(req){
    const ctx = req.ctx;
    if (ctx.h_session)
        this.lum.mgr.feature_used('h_session');
    let session = this._request_session(ctx);
    const authorization = username.parse(ctx.h_proxy_authorization);
    if (authorization)
    {
        if (ctx.h_session)
            authorization.session = ctx.h_session;
        delete authorization.tool;
        session.authorization = authorization;
    }
    if (session && (!session.session || ctx.h_session))
    {
        if (session.authorization && this.session &&
            !(this.session.authorization && _.isEqual(session.authorization,
            this.session.authorization)))
        {
            this.session = null;
        }
        if (ctx.h_session && this.session)
            this.session = null;
        if (req.session)
            session.session = req.session;
        else if (this.session)
            session = this.session;
    }
    return session;
};

Sess_mgr.prototype._get_oldest_session = function(){
    return this.sessions.sessions.sort((a, b)=>a.created-b.created)[0];
};

Sess_mgr.prototype.is_using_pool = function(){
    const sessions = this.sessions && this.sessions.sessions || [];
    return this.opt.pool_prefill || this.opt.pool_size==sessions.length;
};

Sess_mgr.prototype._request_session = function(ctx, opt={}){
    if (ctx.h_session)
        return {session: ctx.h_session};
    if (ctx.pool_key)
    {
        let s_pool = this.session_pools.get(ctx.pool_key), p_sess;
        if (p_sess = s_pool && s_pool.get())
            return p_sess;
    }
    const init_ips_pool = opt.init && this.opt.ips && this.opt.ips.length;
    if (this.opt.pool_size && (this.is_using_pool() || init_ips_pool))
    {
        this.session = null;
        let sessions;
        if (!this.sessions)
        {
            this.sessions = {sessions: sessions = []};
            let size = this.opt.pool_size;
            if (init_ips_pool)
                size = this.opt.ips.length;
            this.pool(size, opt);
            this.pool_ready = true;
        }
        else
        {
            sessions = this.sessions.sessions;
            if (sessions.length!=this.opt.pool_size)
                this.pool(this.opt.pool_size-(sessions.length||0), opt);
        }
        if (this.pool_type==E.pool_types.long_availability)
            return this._get_oldest_session();
        let session = sessions.shift();
        if (!opt.init)
            session.count++;
        if (!opt.init && (this.is_session_expired(session) ||
            this.is_session_banned(session)))
        {
            if (this.opt.pool_size>1 && !this.is_session_banned(session))
            {
                session.count = 0;
                sessions.push(session);
            }
            if (sessions.length<this.opt.pool_size)
                this.pool_fetch();
            session = this.sessions.sessions[0];
            session.count++;
        }
        else
            sessions.unshift(session);
        return session;
    }
    if (!opt.init && this.opt.sticky_ip)
    {
        const ip = ctx.src_addr && ctx.src_addr.replace(/\./g, '_');
        let session = this.sticky_sessions[ip];
        if (!session||this.is_session_expired(session)||
            this.is_session_banned(session))
        {
            session = this.sticky_sessions[ip] = this.establish_session(
                `${ctx.port}_${ip}_${this.seed}`, this.sticky_sessions);
        }
        return session;
    }
    if (this.opt.session===true && !this.opt.sticky_ip)
    {
        if (this.session && !opt.init)
            this.session.count++;
        if (!this.session || this.is_session_expired(this.session) ||
            this.is_session_banned(this.session))
        {
            this.session = this.establish_session(this.seed, this.sessions);
            if (!opt.init)
                this.session.count++;
        }
        return this.session;
    }
    return {session: false};
};

Sess_mgr.prototype.get_req_cred = function(req){
    const ctx = req.ctx;
    const auth = ctx.session && ctx.session.authorization || {};
    const opt = {
        ext_proxy: ctx.session && ctx.session.ext_proxy,
        ip: ctx.session && ctx.session.ip || this.opt.ip,
        vip: ctx.session && ctx.session.vip || this.opt.vip,
        session: ctx.session && ctx.session.session,
        direct: ctx.is_direct,
    };
    return this.calculate_username(assign({}, opt, auth));
};

Sess_mgr.prototype.stop = function(){
    if (this.sp)
        this.sp.return();
};
E.Sess_mgr = Sess_mgr;

const parse_proxy_string = (_url, defaults)=>{
    if (!_url.match(/^(http|https|socks|socks5):\/\//))
        _url = `http://${_url}`;
    _url = Object.assign({}, defaults, _.omitBy(url.parse(_url), v=>!v));
    const proxy = {
        protocol: _url.protocol,
        host: _url.hostname,
        port: _url.port,
        username: _url.username,
        password: _url.password
    };
    let auth = [];
    if (_url.auth)
        auth = _url.auth.split(':');
    proxy.username = auth[0]||proxy.username||'';
    proxy.password = auth[1]||proxy.password||'';
    return proxy;
};
