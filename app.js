/* ==========================================================================
   THE MAN CAVE — App Logic
   ESPN + NWS + NIFC/ArcGIS + Geolocation + Nominatim
   ========================================================================== */

// Global error handler — never let JS errors kill the app
window.onerror = function(){ var sp=document.getElementById('splash'); if(sp){sp.classList.add('bye');document.getElementById('app').style.opacity='1';} };
window.addEventListener('unhandledrejection', function(){ var sp=document.getElementById('splash'); if(sp){sp.classList.add('bye');document.getElementById('app').style.opacity='1';} });

// ---- Configuration ----
const FAV_IDS = new Set([12, 21, 9]);
const FAV_NAMES = { 12:'LA Clippers', 21:'Phoenix Suns', 9:'Golden State Warriors' };
const DEFAULT_LAT = 35.1894, DEFAULT_LON = -114.0530, DEFAULT_CITY = 'Kingman, AZ';
const REFRESH_MS = 120000;

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const SPORT_EP = {
  nba:   ESPN_BASE + '/basketball/nba/scoreboard',
  ncaab: ESPN_BASE + '/basketball/mens-college-basketball/scoreboard',
  mlb:   ESPN_BASE + '/baseball/mlb/scoreboard',
  cbase: ESPN_BASE + '/baseball/college-baseball/scoreboard',
  nfl:   ESPN_BASE + '/football/nfl/scoreboard',
  cfb:   ESPN_BASE + '/football/college-football/scoreboard',
};
const NBA_NEWS_EP = ESPN_BASE + '/basketball/nba/news?limit=15';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org';
const NWS_PTS = 'https://api.weather.gov/points';
const FIRE_EP = 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

// ---- State ----
let userLat = DEFAULT_LAT, userLon = DEFAULT_LON, userCity = DEFAULT_CITY;
let nwsForecastUrl = null, nwsHourlyUrl = null;
let refreshTimer = null, cdTimer = null, cdVal = 120;
let nbaCache = null;

// ---- DOM ----
const $ = (id) => document.getElementById(id);

// ---- Helpers ----
function timeAgo(d) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function fmtDate(d) {
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
}
function wxIcon(f) {
  const s = (f||'').toLowerCase();
  if (s.includes('thunder')||s.includes('tstorm')) return '⛈️';
  if (s.includes('rain')||s.includes('shower')||s.includes('drizzle')) return '🌧️';
  if (s.includes('snow')||s.includes('blizzard')||s.includes('flurr')) return '🌨️';
  if (s.includes('fog')||s.includes('mist')||s.includes('haze')) return '🌫️';
  if (s.includes('cloud')||s.includes('overcast')) return s.includes('partly')?'⛅':'☁️';
  if (s.includes('wind')) return '💨';
  if (s.includes('hot')||s.includes('heat')) return '🔥';
  if (s.includes('clear')||s.includes('sunny')||s.includes('fair')) return s.includes('night')?'🌙':'☀️';
  return '🌤️';
}
function haversine(la1,lo1,la2,lo2) {
  const R=3959,dLa=(la2-la1)*Math.PI/180,dLo=(lo2-lo1)*Math.PI/180;
  const a=Math.sin(dLa/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dLo/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function errHTML(ic,msg,sub){return '<div class="err-card"><div class="e-i">'+ic+'</div><div class="e-m">'+msg+'</div>'+(sub?'<div class="e-r">'+sub+'</div>':'')+'</div>';}
function emptyHTML(ic,t,s){return '<div class="empty-card"><div class="em-i">'+ic+'</div><div class="em-t">'+t+'</div>'+(s?'<div class="em-s">'+s+'</div>':'')+'</div>';}
function splashPct(p){ /* no-op */ }

async function fetchJ(url,ms){
  var c=new AbortController();var t=setTimeout(function(){c.abort();},ms||10000);
  try{var r=await fetch(url,{signal:c.signal});if(!r.ok)throw new Error(r.status);return await r.json();}
  finally{clearTimeout(t);}
}

// ===========================================================================
// TAB NAVIGATION
// ===========================================================================
function switchTab(name, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  $('page-'+name).classList.add('active');
  if(btn)btn.classList.add('active');
  $('contentArea').scrollTop=0;
}
function subTab(page,sub,btn) {
  var par=$('page-'+page);
  par.querySelectorAll('[id^="'+page+'-"]').forEach(s=>s.style.display='none');
  par.querySelectorAll('.s-tab').forEach(t=>t.classList.remove('active'));
  $(page+'-'+sub).style.display='block';
  if(btn)btn.classList.add('active');
}

// ===========================================================================
// GEOLOCATION
// ===========================================================================
async function initLocation() {
  var dot=$('locDot'), txt=$('locText');
  dot.className='loc-dot wait'; txt.textContent='Detecting your location…';
  if(!navigator.geolocation){
    dot.className='loc-dot err'; txt.textContent='Using default: '+DEFAULT_CITY;
    await resolveNWS(DEFAULT_LAT,DEFAULT_LON); return;
  }
  try {
    var pos = await new Promise(function(ok,fail){
      navigator.geolocation.getCurrentPosition(ok,fail,{timeout:5000,enableHighAccuracy:false});
    });
    userLat=pos.coords.latitude; userLon=pos.coords.longitude;
    try {
      var rev=await fetchJ(NOMINATIM_BASE+'/reverse?format=json&lat='+userLat+'&lon='+userLon,6000);
      var ad=rev.address||{};
      userCity=(ad.city||ad.town||ad.village||ad.county||'Your Location')+(ad.state?', '+ad.state:'');
    } catch(e){ userCity=userLat.toFixed(2)+'\u00b0, '+userLon.toFixed(2)+'\u00b0'; }
    dot.className='loc-dot ok'; txt.textContent=userCity;
    await resolveNWS(userLat,userLon);
  } catch(e) {
    dot.className='loc-dot err'; txt.textContent='Location denied \u00b7 Using '+DEFAULT_CITY;
    userLat=DEFAULT_LAT; userLon=DEFAULT_LON; userCity=DEFAULT_CITY;
    await resolveNWS(DEFAULT_LAT,DEFAULT_LON);
  }
}
async function resolveNWS(lat,lon) {
  try {
    var d=await fetchJ(NWS_PTS+'/'+lat.toFixed(4)+','+lon.toFixed(4));
    nwsForecastUrl=d.properties.forecast; nwsHourlyUrl=d.properties.forecastHourly;
  } catch(e){ nwsForecastUrl=null; }
}

// ===========================================================================
// WEATHER SEARCH
// ===========================================================================
async function searchWeather() {
  var inp=$('wInput'), q=inp.value.trim(); if(!q)return;
  var btn=$('wBtn'); btn.textContent='\u2026'; btn.disabled=true;
  try {
    var geo=await fetchJ(NOMINATIM_BASE+'/search?q='+encodeURIComponent(q)+'&format=json&limit=1',8000);
    if(!geo.length) throw new Error('nope');
    userLat=parseFloat(geo[0].lat); userLon=parseFloat(geo[0].lon);
    userCity=geo[0].display_name.split(',').slice(0,2).join(',').trim();
    $('locDot').className='loc-dot ok'; $('locText').textContent=userCity;
    await resolveNWS(userLat,userLon);
    await Promise.all([loadWeather(), loadFire()]);
    inp.value='';
  } catch(e) {
    $('weatherCard').innerHTML=errHTML('—','Couldn\'t find "'+q+'"','Try a city name like "Phoenix, AZ"');
  } finally { btn.textContent='Go'; btn.disabled=false; }
}

// ===========================================================================
// WEATHER
// ===========================================================================
async function loadWeather() {
  try {
    if(!nwsForecastUrl) throw new Error('No NWS');
    var fc=await fetchJ(nwsForecastUrl);
    var pp=fc.properties.periods; if(!pp||!pp.length)throw new Error('empty');
    var n=pp[0], temp=n.temperature, unit=n.temperatureUnit||'F';
    var cond=n.shortForecast, wind=n.windSpeed+' '+n.windDirection;
    var hum=n.relativeHumidity?n.relativeHumidity.value+'%':'\u2014';
    var precip=n.probabilityOfPrecipitation?n.probabilityOfPrecipitation.value:null;
    var dew=n.dewpoint?Math.round(n.dewpoint.value*9/5+32)+'\u00b0F':'\u2014';
    var feelsLike='';
    if(temp>=80&&hum!=='\u2014'){var h2=parseFloat(hum);if(h2>40)feelsLike='Feels hotter due to humidity';}
    else if(temp<=50&&n.windSpeed){var ws=parseFloat(n.windSpeed);if(ws>3)feelsLike='Wind chill in effect';}
    var detailTxt=n.detailedForecast||'';

    $('weatherCard').innerHTML='<div class="weather-card">'
      +'<div class="w-loc">'+userCity+'</div>'
      +'<div class="w-main"><div class="w-left"><div class="w-icon">'+wxIcon(cond)+'</div>'
      +'<div><div class="w-temp">'+temp+'<span class="w-deg">\u00b0'+unit+'</span></div></div></div>'
      +'<div class="w-right"><div class="w-cond">'+cond+'</div>'
      +'<div class="w-detail">'
      +'Wind: '+wind+'<br>Humidity: '+hum+'<br>Dew Point: '+dew
      +(precip!=null?'<br>Rain: '+precip+'%':'')
      +(feelsLike?'<br><em>'+feelsLike+'</em>':'')
      +'</div></div></div>'
      +(detailTxt?'<div class="w-detailed">'+detailTxt+'</div>':'')
      +'</div>';

    var fh='<div class="forecast-scroll">';
    for(var i=0;i<pp.length&&i<14;i++){
      var p=pp[i];
      if(p.isDaytime){
        var night=pp[i+1], lo=night?night.temperature:'\u2014';
        var dl=p.name.length>8?p.name.substring(0,6)+'\u2026':p.name;
        var prc=p.probabilityOfPrecipitation?p.probabilityOfPrecipitation.value:null;
        fh+='<div class="fc-item"><div class="fc-day">'+dl+'</div>'
          +'<div class="fc-icon">'+wxIcon(p.shortForecast)+'</div>'
          +'<div class="fc-temp">'+p.temperature+'\u00b0</div>'
          +'<div class="fc-lo">'+lo+'\u00b0</div>'
          +(prc!=null&&prc>0?'<div class="fc-precip">\ud83d\udca7'+prc+'%</div>':'')
          +'</div>';
      }
    }
    fh+='</div>';
    $('forecastSection').innerHTML=fh;

    var eh='';
    pp.forEach(function(p,i){
      if(i>13)return;
      var prc2=p.probabilityOfPrecipitation?p.probabilityOfPrecipitation.value:null;
      var hum2=p.relativeHumidity?p.relativeHumidity.value+'%':'';
      eh+='<div class="ext-fc" data-i="'+(i%10)+'">'
        +'<div class="ext-hdr"><span class="ext-icon">'+wxIcon(p.shortForecast)+'</span>'
        +'<span class="ext-day">'+p.name+'</span>'
        +'<span class="ext-temp">'+p.temperature+'\u00b0'+p.temperatureUnit+'</span></div>'
        +'<div class="ext-stats">'
        +'<span>Wind: '+p.windSpeed+' '+p.windDirection+'</span>'
        +(hum2?'<span> \u00b7 Humidity: '+hum2+'</span>':'')
        +(prc2!=null?'<span> \u00b7 Rain: '+prc2+'%</span>':'')
        +'</div>'
        +'<div class="ext-body">'+p.detailedForecast+'</div></div>';
    });
    $('extForecast').innerHTML=eh||emptyHTML('\u2014','No forecast data');

    if(nwsHourlyUrl){
      try{
        var hr=await fetchJ(nwsHourlyUrl);
        var hp=hr.properties.periods||[];
        var hh='<div class="sh" style="margin-top:12px"><svg class="sh-icon" viewBox="0 0 24 24"><path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg><span class="sh-t">Hourly</span></div>';
        hh+='<div class="hourly-scroll">';
        for(var hi=0;hi<hp.length&&hi<12;hi++){
          var h3=hp[hi];
          var hTime=new Date(h3.startTime).toLocaleTimeString('en-US',{hour:'numeric'});
          var hPrc=h3.probabilityOfPrecipitation?h3.probabilityOfPrecipitation.value:null;
          hh+='<div class="hr-item"><div class="hr-time">'+hTime+'</div>'
            +'<div class="hr-icon">'+wxIcon(h3.shortForecast)+'</div>'
            +'<div class="hr-temp">'+h3.temperature+'\u00b0</div>'
            +(hPrc!=null&&hPrc>0?'<div class="hr-precip">\ud83d\udca7'+hPrc+'%</div>':'')
            +'<div class="hr-wind">'+h3.windSpeed+'</div></div>';
        }
        hh+='</div>';
        $('forecastSection').innerHTML+= hh;
      }catch(e){}
    }
  } catch(e) {
    $('weatherCard').innerHTML=errHTML('\u2014',
      nwsForecastUrl?'Weather unavailable right now':'Weather only works for US locations',
      'Trying again shortly');
    $('forecastSection').innerHTML='';
    $('extForecast').innerHTML=errHTML('\u2014','Forecast unavailable right now','Try a US city');
  }
}

// ===========================================================================
// FIRE WATCH
// ===========================================================================
async function loadFire() {
  try {
    // Fetch ALL active fires nationwide — like Watch Duty
    var url=FIRE_EP+'?where=1%3D1&outFields=IncidentName,IncidentSize,PercentContained,POOLatitude,POOLongitude,POOState,IncidentTypeCategory,FireDiscoveryDateTime,DailyAcres'
      +'&f=json&resultRecordCount=200&orderByFields=DailyAcres+DESC';
    var data=await fetchJ(url,15000);
    var fires=(data.features||[]).map(function(f){
      var a=f.attributes, lat=a.POOLatitude||(f.geometry&&f.geometry.y), lon=a.POOLongitude||(f.geometry&&f.geometry.x);
      var dist=(lat&&lon)?haversine(userLat,userLon,lat,lon):99999;
      return Object.assign({},a,{dist:dist,lat:lat,lon:lon});
    }).filter(function(f){return f.IncidentName;})
      .sort(function(a,b){return a.dist-b.dist;});
    // Nearby fires first (within 200mi), then biggest fires nationwide
    var nearby=fires.filter(function(f){return f.dist<200;});
    var big=fires.filter(function(f){return f.dist>=200&&(f.DailyAcres||f.IncidentSize||0)>=100;}).sort(function(a,b){return (b.DailyAcres||b.IncidentSize||0)-(a.DailyAcres||a.IncidentSize||0);}).slice(0,25);
    fires=nearby.concat(big);

    if(!fires.length){
      var safe='<div class="fire-safe"><div class="fire-safe-i"><svg viewBox="0 0 24 24" width="40" height="40"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="#22c55e" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>'
        +'<div class="fire-safe-t">All Clear</div>'
        +'<div class="fire-safe-s">No active wildfires reported</div></div>';
      $('fireCard').innerHTML=safe; $('alertsFire').innerHTML=safe;
    } else {
      // Home page: top 5 summary
      var hShort='';
      fires.slice(0,5).forEach(function(f,i){
        var ac=f.DailyAcres||f.IncidentSize||0;
        var pct=f.PercentContained!=null?f.PercentContained+'%':'N/A';
        var st=f.POOState||'';
        var isNear=f.dist<200;
        hShort+='<div class="fire-card'+(isNear?' fire-near':'')+'" data-i="'+i+'">'
          +'<div class="fire-hdr"><span class="fire-dot'+(isNear?' fire-dot-near':'')+'"></span><span class="fire-nm">'+f.IncidentName+'</span>'
          +'<span class="fire-dist">'+(isNear?f.dist.toFixed(0)+' mi':st)+'</span></div>'
          +'<div class="fire-stats"><span class="fire-stat"><strong>'+(ac?ac.toLocaleString():'\u2014')+'</strong> acres</span>'
          +'<span class="fire-stat"><strong>'+pct+'</strong> contained</span>'
          +'</div></div>';
      });
      hShort+='<div class="fire-more" onclick="switchTab(\u0027alerts\u0027,document.querySelectorAll(\u0027.tab-btn\u0027)[4])">View all '+fires.length+' fires \u2192</div>';
      $('fireCard').innerHTML=hShort;

      // Alerts page: full detailed list
      var hFull='<div class="fire-summary"><strong>'+fires.length+'</strong> active fires tracked \u00b7 <strong>'+nearby.length+'</strong> within 200 miles</div>';
      if(nearby.length>0){
        hFull+='<div class="fire-section-hdr">Near You (within 200 mi)</div>';
        nearby.forEach(function(f,i){
          var ac=f.DailyAcres||f.IncidentSize||0;
          var pct=f.PercentContained!=null?f.PercentContained+'%':'N/A';
          var disc=f.FireDiscoveryDateTime?new Date(f.FireDiscoveryDateTime).toLocaleDateString():'';
          hFull+='<div class="fire-card fire-near" data-i="'+(i%10)+'">'
            +'<div class="fire-hdr"><span class="fire-dot fire-dot-near"></span><span class="fire-nm">'+f.IncidentName+'</span>'
            +'<span class="fire-dist">'+f.dist.toFixed(0)+' mi</span></div>'
            +'<div class="fire-stats"><span class="fire-stat"><strong>'+(ac?ac.toLocaleString():'\u2014')+'</strong> acres</span>'
            +'<span class="fire-stat"><strong>'+pct+'</strong> contained</span>'
            +(disc?'<span class="fire-stat">Since '+disc+'</span>':'')
            +'</div></div>';
        });
      }
      if(big.length>0){
        hFull+='<div class="fire-section-hdr">Major Fires Nationwide</div>';
        big.forEach(function(f,i){
          var ac=f.DailyAcres||f.IncidentSize||0;
          var pct=f.PercentContained!=null?f.PercentContained+'%':'N/A';
          var disc=f.FireDiscoveryDateTime?new Date(f.FireDiscoveryDateTime).toLocaleDateString():'';
          var st=f.POOState||'';
          hFull+='<div class="fire-card" data-i="'+(i%10)+'">'
            +'<div class="fire-hdr"><span class="fire-dot"></span><span class="fire-nm">'+f.IncidentName+'</span>'
            +'<span class="fire-dist">'+st+(f.dist<99999?' \u00b7 '+f.dist.toFixed(0)+' mi':'')+'</span></div>'
            +'<div class="fire-stats"><span class="fire-stat"><strong>'+(ac?ac.toLocaleString():'\u2014')+'</strong> acres</span>'
            +'<span class="fire-stat"><strong>'+pct+'</strong> contained</span>'
            +(disc?'<span class="fire-stat">Since '+disc+'</span>':'')
            +'</div></div>';
        });
      }
      $('alertsFire').innerHTML=hFull;
    }
  } catch(e) {
    var fb=errHTML('—','Fire data unavailable right now','Trying again shortly');
    $('fireCard').innerHTML=fb; $('alertsFire').innerHTML=fb;
  }
}

// ===========================================================================
// ESPN SCOREBOARD
// ===========================================================================
// Extract playoff/series info from an ESPN event
function getSeriesInfo(game) {
  var c = game.competitions && game.competitions[0];
  if (!c) return null;
  var isPostseason = game.season && game.season.type === 3;
  if (!isPostseason) return null;

  var info = { isPlayoff: true, title: '', summary: '', gameNumber: 0, headline: '' };

  // series object (e.g. {title:"NBA Finals", summary:"NYK leads 2-0", completed:false, ...})
  var series = c.series;
  if (series) {
    info.title = series.title || '';
    info.summary = series.summary || '';
    info.gameNumber = series.gameNumber || 0;
  }

  // notes array — often has "NBA Finals - Game 3" as headline
  var notes = c.notes || [];
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].headline) { info.headline = notes[i].headline; break; }
  }

  // Build display string: prefer headline, fall back to constructed text
  if (!info.headline && info.title) {
    info.headline = info.title + (info.gameNumber ? ' - Game ' + info.gameNumber : '');
  }

  return (info.headline || info.summary) ? info : null;
}

function gameHTML(game,i,sport) {
  var c=game.competitions&&game.competitions[0]; if(!c)return '';
  var teams=c.competitors||[];
  var home=teams.find(function(t){return t.homeAway==='home';})||teams[0];
  var away=teams.find(function(t){return t.homeAway==='away';})||teams[1];
  if(!home||!away)return '';

  var st=game.status&&game.status.type;
  var isLive=st&&st.state==='in', isFinal=st&&st.state==='post', isPre=st&&st.state==='pre';
  var stTxt=(st&&(st.shortDetail||st.detail))||'';
  var isFav=sport==='nba'&&(FAV_IDS.has(Number(home.team&&home.team.id))||FAV_IDS.has(Number(away.team&&away.team.id)));

  var cls='game-card';
  if(isLive)cls+=' live-game';
  if(isFav)cls+=' fav-game';

  // Playoff series info
  var seriesInfo = (sport === 'nba' || sport === 'ncaab') ? getSeriesInfo(game) : null;
  if(seriesInfo) cls += ' playoff-game';

  var hW=false,aW=false;
  if(isFinal){hW=Number(home.score)>Number(away.score);aW=Number(away.score)>Number(home.score);}

  var bc=c.broadcasts?c.broadcasts.flatMap(function(b){return b.names||[];}):[];
  var bcT=bc.slice(0,2).join(', ');

  function tRow(t,win,lose){
    var logo=(t.team&&t.team.logo)||'';
    var nm=(t.team&&(t.team.shortDisplayName||t.team.displayName||t.team.name))||'?';
    var rec=(t.records&&t.records[0]&&t.records[0].summary)||'';
    var sc=(isLive||isFinal)?(t.score||'0'):'';
    var rc='t-row'; if(win)rc+=' winner'; if(lose)rc+=' loser';
    return '<div class="'+rc+'">'
      +(logo?'<img class="t-logo" src="'+logo+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">':'<div class="t-logo"></div>')
      +'<span class="t-name">'+nm+(rec?'<span class="t-rec">('+rec+')</span>':'')+'</span>'
      +'<span class="t-score">'+sc+'</span></div>';
  }

  var sHTML='';
  if(isLive){
    sHTML='<span class="g-status live"><span class="live-dot"></span><span class="live-badge">LIVE</span> '+stTxt+'</span>';
  } else {
    sHTML='<span class="g-status">'+stTxt+'</span>';
  }

  // Build playoff badge HTML
  var seriesHTML = '';
  if (seriesInfo) {
    seriesHTML = '<div class="series-bar">';
    seriesHTML += '<span class="series-badge">🏆 PLAYOFFS</span>';
    if (seriesInfo.headline) seriesHTML += '<span class="series-title">' + seriesInfo.headline + '</span>';
    if (seriesInfo.summary) seriesHTML += '<span class="series-summary">' + seriesInfo.summary + '</span>';
    seriesHTML += '</div>';
  }

  return '<div class="'+cls+'" data-i="'+(i%10)+'">'
    +'<div class="g-sbar">'+sHTML+(bcT?'<span class="g-bc">'+bcT+'</span>':'')+'</div>'
    +seriesHTML
    +tRow(away,aW,hW&&isFinal)+tRow(home,hW,aW&&isFinal)+'</div>';
}

async function loadBoard(sport,boardId,countId) {
  try {
    var data=await fetchJ(SPORT_EP[sport]);
    var ev=data.events||[];
    if(sport==='nba')nbaCache=data;
    var cel=$(countId); if(cel)cel.textContent=ev.length;
    if(!ev.length){
      var si=data.leagues&&data.leagues[0]&&data.leagues[0].season;
      $(boardId).innerHTML=emptyHTML('—','No games today',
        si?'Season: '+(si.displayName||si.year):'Check back later');
      return;
    }
    $(boardId).innerHTML=ev.map(function(g,i){return gameHTML(g,i,sport);}).join('');
  } catch(e) {
    $(boardId).innerHTML=errHTML('—','Scores unavailable right now','Trying again shortly');
    var cel2=$(countId); if(cel2)cel2.textContent='\u2014';
  }
}

// ===========================================================================
// NBA UPCOMING GAMES (next 6 days)
// ===========================================================================
async function loadNBAUpcoming() {
  var container = $('nbaUpcoming');
  if (!container) return;

  var dates = [];
  var now = new Date();
  for (var i = 1; i <= 6; i++) {
    var d = new Date(now);
    d.setDate(d.getDate() + i);
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    dates.push({
      str: yyyy + mm + dd,
      date: d,
      label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    });
  }

  // Fetch all 6 days in parallel
  var dayResults = await Promise.allSettled(dates.map(function(wd) {
    return fetchJ(SPORT_EP.nba + '?dates=' + wd.str, 10000).then(function(data) {
      return { dateInfo: wd, events: data.events || [] };
    });
  }));

  var html = '';
  var totalGames = 0;

  dayResults.forEach(function(result) {
    if (result.status !== 'fulfilled' || !result.value.events.length) return;
    var dayData = result.value;
    totalGames += dayData.events.length;

    html += '<div class="upcoming-day">';
    html += '<div class="upcoming-day-hdr">' + dayData.dateInfo.label
      + '<span class="upcoming-day-ct">' + dayData.events.length + ' game'
      + (dayData.events.length > 1 ? 's' : '') + '</span></div>';

    dayData.events.forEach(function(ev, idx) {
      var comp = ev.competitions && ev.competitions[0];
      if (!comp) return;
      var teams = comp.competitors || [];
      var home = teams.find(function(t) { return t.homeAway === 'home'; }) || teams[0];
      var away = teams.find(function(t) { return t.homeAway === 'away'; }) || teams[1];
      if (!home || !away) return;

      var st = ev.status && ev.status.type;
      var stState = st && st.state;
      var stTxt = (st && (st.shortDetail || st.detail)) || '';
      var isLive = stState === 'in';
      var isFinal = stState === 'post';
      var isPre = stState === 'pre';
      var isFav = FAV_IDS.has(Number(home.team && home.team.id)) || FAV_IDS.has(Number(away.team && away.team.id));

      var gameDate = new Date(ev.date || comp.date);
      var timeStr = isPre ? gameDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : stTxt;

      var homeName = (home.team && (home.team.shortDisplayName || home.team.abbreviation || home.team.name)) || '?';
      var awayName = (away.team && (away.team.shortDisplayName || away.team.abbreviation || away.team.name)) || '?';
      var homeLogo = (home.team && home.team.logo) || '';
      var awayLogo = (away.team && away.team.logo) || '';

      // Broadcasts
      var bcast = comp.broadcasts ? comp.broadcasts.flatMap(function(b) { return b.names || []; }) : [];
      var bcT = bcast.slice(0, 2).join(', ');

      // Series info
      var seriesInfo = getSeriesInfo(ev);

      var cardCls = 'upcoming-game';
      if (isFav) cardCls += ' upcoming-fav';
      if (isLive) cardCls += ' upcoming-live';
      if (seriesInfo) cardCls += ' upcoming-playoff';

      var scoreHtml = '';
      if (isLive || isFinal) {
        scoreHtml = '<span class="upcoming-score">' + (away.score || '0') + ' - ' + (home.score || '0') + '</span>';
      }

      html += '<div class="' + cardCls + '">';

      // Series info row
      if (seriesInfo) {
        html += '<div class="upcoming-series">';
        html += '<span class="upcoming-series-badge">🏆</span>';
        if (seriesInfo.headline) html += '<span class="upcoming-series-hl">' + seriesInfo.headline + '</span>';
        if (seriesInfo.summary) html += '<span class="upcoming-series-sum">' + seriesInfo.summary + '</span>';
        html += '</div>';
      }

      // Teams row
      html += '<div class="upcoming-matchup">';
      html += '<div class="upcoming-team">';
      if (awayLogo) html += '<img class="upcoming-logo" src="' + awayLogo + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
      html += '<span class="upcoming-name">' + awayName + '</span></div>';
      html += '<span class="upcoming-vs">' + (isLive || isFinal ? scoreHtml : '@') + '</span>';
      html += '<div class="upcoming-team">';
      if (homeLogo) html += '<img class="upcoming-logo" src="' + homeLogo + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
      html += '<span class="upcoming-name">' + homeName + '</span></div>';
      html += '</div>';

      // Meta row
      html += '<div class="upcoming-meta">';
      html += '<span class="upcoming-time' + (isLive ? ' upcoming-time-live' : '') + '">';
      if (isLive) html += '<span class="live-dot"></span>';
      html += timeStr + '</span>';
      if (bcT) html += '<span class="upcoming-bc">' + bcT + '</span>';
      html += '</div>';

      html += '</div>';
    });

    html += '</div>';
  });

  if (!html) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<div class="sh" style="margin-top:22px">'
    + '<svg class="sh-icon" viewBox="0 0 24 24"><path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '<span class="sh-t">Coming Up</span>'
    + '<span class="sh-badge">' + totalGames + '</span></div>'
    + html;
}

// ===========================================================================
// FAVORITE TEAMS
// ===========================================================================
async function loadFavs() {
  try {
    if(!nbaCache){
      try{nbaCache=await fetchJ(SPORT_EP.nba);}catch(e){nbaCache={events:[]};}
    }
    var ev=nbaCache.events||[];
    var html='';
    var ids=Object.keys(FAV_NAMES);
    ids.forEach(function(idStr,idx){
      var id=Number(idStr), info=FAV_NAMES[idStr];
      var game=ev.find(function(e){
        var cs=e.competitions&&e.competitions[0]&&e.competitions[0].competitors;
        return cs&&cs.some(function(c){return Number(c.team&&c.team.id)===id;});
      });

      var body='',logo='',record='';
      if(game){
        var c=game.competitions[0], ts=c.competitors||[];
        var my=ts.find(function(t){return Number(t.team&&t.team.id)===id;});
        var opp=ts.find(function(t){return Number(t.team&&t.team.id)!==id;});
        logo=(my&&my.team&&my.team.logo)||'';
        record=(my&&my.records&&my.records[0]&&my.records[0].summary)||'';
        var st=game.status&&game.status.type;
        var isLive=st&&st.state==='in', isFinal=st&&st.state==='post';
        var stTxt=(st&&(st.shortDetail||st.detail))||'';
        var oppNm=(opp&&opp.team&&(opp.team.shortDisplayName||opp.team.name))||'?';
        var isHome=my&&my.homeAway==='home';
        var pfx=isHome?'vs':'@';

        if(isLive){
          body='<div><span class="live-badge" style="display:inline-block;margin-bottom:4px">LIVE</span> '+stTxt+'</div>'
            +'<div class="score-line">'+info.split(' ').pop()+' '+my.score+' - '+opp.score+' '+oppNm+'</div>';
        } else if(isFinal){
          var won=Number(my.score)>Number(opp.score);
          body='<div>'+stTxt+'</div><div class="score-line '+(won?'win':'loss')+'">'
            +(won?'W':'L')+' '+my.score+' - '+opp.score+' '+pfx+' '+oppNm+'</div>';
        } else {
          body='<div>Next Game</div><div class="score-line">'+pfx+' '+oppNm+'</div><div>'+stTxt+'</div>';
        }
      } else {
        body='<div>No game today</div>';
      }

      html+='<div class="fav-card" data-team="'+id+'" data-i="'+idx+'">'
        +'<div class="fav-hdr">'
        +(logo?'<img class="fav-logo" src="'+logo+'" alt="'+info+'" loading="lazy" onerror="this.style.display=\'none\'">':'')
        +'<div class="fav-info"><div class="fav-name">'+info+'</div>'
        +(record?'<div class="fav-rec">'+record+'</div>':'')
        +'</div></div><div class="fav-body">'+body+'</div></div>';
    });
    $('favTeams').innerHTML=html||emptyHTML('—','No team info right now');
  } catch(e) {
    $('favTeams').innerHTML=errHTML('—','Teams unavailable','Trying again shortly');
  }
}

// ===========================================================================
// WEEKLY OUTLOOK — Upcoming games for favorite teams + all sports
// ===========================================================================
const SCHEDULE_EP = {
  nba: ESPN_BASE + '/basketball/nba/scoreboard?dates=',
  mlb: ESPN_BASE + '/baseball/mlb/scoreboard?dates=',
  nfl: ESPN_BASE + '/football/nfl/scoreboard?dates=',
};

function getWeekDates() {
  var dates = [];
  var now = new Date();
  for (var i = 0; i < 7; i++) {
    var d = new Date(now);
    d.setDate(d.getDate() + i);
    var yyyy = d.getFullYear();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    dates.push({ str: yyyy + mm + dd, date: d, label: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  return dates;
}

function sportIcon(sport) {
  if (sport === 'nba') return '<svg class="wk-sport-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M4.93 4.93c4.08 2.38 6.2 5.73 6.37 10.07M19.07 4.93c-4.08 2.38-6.2 5.73-6.37 10.07M2 12h20" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
  if (sport === 'mlb') return '<svg class="wk-sport-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none"/><path d="M8 2.5c-1 2.5-1 5.5 0 8s1 5.5 0 8M16 21.5c1-2.5 1-5.5 0-8s-1-5.5 0-8" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
  if (sport === 'nfl') return '<svg class="wk-sport-icon" viewBox="0 0 24 24"><ellipse cx="12" cy="12" rx="10" ry="7" transform="rotate(-45 12 12)" stroke="currentColor" stroke-width="2" fill="none"/><path d="M7.5 7.5l9 9" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
  return '';
}

async function loadWeeklyOutlook() {
  var weekDates = getWeekDates();
  var allGames = [];

  // Determine which sports are currently in-season to avoid wasted API calls.
  // NBA season: Oct-Jun (postseason May-Jun), NFL: Sep-Feb, MLB: Mar-Oct
  var month = new Date().getMonth(); // 0-indexed
  var activeSports = [];
  // NBA: roughly Oct(9) through Jun(5) inclusive
  if (month >= 9 || month <= 5) activeSports.push('nba');
  // MLB: roughly Mar(2) through Oct(9) inclusive
  if (month >= 2 && month <= 9) activeSports.push('mlb');
  // NFL: roughly Sep(8) through Feb(1) inclusive
  if (month >= 8 || month <= 1) activeSports.push('nfl');
  // Fallback: always include at least NBA
  if (!activeSports.length) activeSports.push('nba');

  // Fetch each in-season sport's schedule for the week
  var fetches = [];
  activeSports.forEach(function(sport) {
    weekDates.forEach(function(wd) {
      fetches.push(
        fetchJ(SCHEDULE_EP[sport] + wd.str, 8000)
          .then(function(data) {
            var events = data.events || [];
            events.forEach(function(ev) {
              var comp = ev.competitions && ev.competitions[0];
              if (!comp) return;
              var teams = comp.competitors || [];
              // Check if any favorite team is playing (for NBA) or include all games for other sports
              var isFavGame = false;
              var favTeam = null, oppTeam = null;
              teams.forEach(function(t) {
                if (FAV_IDS.has(Number(t.team && t.team.id))) {
                  isFavGame = true;
                  favTeam = t;
                } else {
                  oppTeam = t;
                }
              });
              // Show all games for all sports
              var home = teams.find(function(t) { return t.homeAway === 'home'; }) || teams[0];
              var away = teams.find(function(t) { return t.homeAway === 'away'; }) || teams[1];
              var st = ev.status && ev.status.type;
              var gameDate = new Date(ev.date || comp.date);
              var bcast = comp.broadcasts ? comp.broadcasts.flatMap(function(b){ return b.names||[]; }) : [];
              var geoBcast = comp.geoBroadcasts || [];
              geoBcast.forEach(function(gb) {
                if (gb.media && gb.media.shortName && bcast.indexOf(gb.media.shortName) === -1) bcast.push(gb.media.shortName);
              });
              // Get series info for this event
              var evSeriesInfo = getSeriesInfo(ev);
              allGames.push({
                sport: sport,
                date: gameDate,
                dateStr: wd.str,
                dateLabel: wd.label,
                home: home,
                away: away,
                status: st,
                statusText: (st && (st.shortDetail || st.detail)) || '',
                isFav: isFavGame,
                name: ev.shortName || ev.name || '',
                broadcast: bcast.slice(0, 3).join(', '),
                seriesInfo: evSeriesInfo
              });
            });
          })
          .catch(function() { /* skip failed fetches */ })
      );
    });
  });

  await Promise.allSettled(fetches);

  // Sort by date
  allGames.sort(function(a, b) { return a.date - b.date; });

  // Remove duplicates (same teams, same date)
  var seen = new Set();
  allGames = allGames.filter(function(g) {
    var key = g.sport + g.dateStr + (g.home.team && g.home.team.id) + (g.away.team && g.away.team.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!allGames.length) {
    $('weeklyOutlook').innerHTML = emptyHTML('\u2014', 'No upcoming games this week', 'Check back later');
    return;
  }

  // Group by day
  var grouped = {};
  allGames.forEach(function(g) {
    if (!grouped[g.dateStr]) grouped[g.dateStr] = { label: g.dateLabel, games: [] };
    grouped[g.dateStr].games.push(g);
  });

  var html = '';
  Object.keys(grouped).sort().forEach(function(ds) {
    var day = grouped[ds];
    var isToday = ds === weekDates[0].str;
    html += '<div class="wk-day' + (isToday ? ' wk-today' : '') + '">';
    html += '<div class="wk-day-hdr">' + (isToday ? 'Today' : day.label) + '<span class="wk-day-ct">' + day.games.length + ' game' + (day.games.length > 1 ? 's' : '') + '</span></div>';
    day.games.forEach(function(g) {
      var homeName = (g.home.team && (g.home.team.shortDisplayName || g.home.team.abbreviation || g.home.team.name)) || '?';
      var awayName = (g.away.team && (g.away.team.shortDisplayName || g.away.team.abbreviation || g.away.team.name)) || '?';
      var homeLogo = (g.home.team && g.home.team.logo) || '';
      var awayLogo = (g.away.team && g.away.team.logo) || '';
      var stState = g.status && g.status.state;
      var isLive = stState === 'in';
      var isFinal = stState === 'post';
      var isPre = stState === 'pre';
      var timeStr = '';
      if (isPre) {
        timeStr = g.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      } else {
        timeStr = g.statusText;
      }

      var scoreHtml = '';
      if (isLive || isFinal) {
        var hScore = g.home.score || '0';
        var aScore = g.away.score || '0';
        scoreHtml = '<span class="wk-score">' + aScore + ' - ' + hScore + '</span>';
      }

      html += '<div class="wk-game' + (g.isFav ? ' wk-fav' : '') + (isLive ? ' wk-live' : '') + (g.seriesInfo ? ' wk-playoff' : '') + '">';
      if (g.seriesInfo) {
        html += '<div class="wk-series-row"><span class="wk-series-badge">🏆</span>';
        if (g.seriesInfo.headline) html += '<span class="wk-series-hl">' + g.seriesInfo.headline + '</span>';
        if (g.seriesInfo.summary) html += '<span class="wk-series-sum">' + g.seriesInfo.summary + '</span>';
        html += '</div>';
      }
      html += '<div class="wk-game-inner">';
      html += '<div class="wk-sport">' + sportIcon(g.sport) + '</div>';
      html += '<div class="wk-teams">';
      html += '<div class="wk-team">' + (awayLogo ? '<img class="wk-logo" src="' + awayLogo + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') + '<span>' + awayName + '</span></div>';
      html += '<span class="wk-at">' + (isLive || isFinal ? scoreHtml : '@') + '</span>';
      html += '<div class="wk-team">' + (homeLogo ? '<img class="wk-logo" src="' + homeLogo + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '') + '<span>' + homeName + '</span></div>';
      html += '</div>';
      html += '<div class="wk-meta">';
      html += '<div class="wk-time' + (isLive ? ' wk-time-live' : '') + '">' + (isLive ? '<span class="live-dot"></span>' : '') + timeStr + '</div>';
      if (g.broadcast) html += '<div class="wk-bc">' + g.broadcast + '</div>';
      html += '</div>';
      html += '</div>'; // close wk-game-inner
      html += '</div>';
    });
    html += '</div>';
  });

  $('weeklyOutlook').innerHTML = html;
}

// ===========================================================================
// NBA NEWS
// ===========================================================================
async function loadNews() {
  try {
    var data=await fetchJ(NBA_NEWS_EP);
    var arts=data.articles||[];
    if(!arts.length){$('homeNews').innerHTML=emptyHTML('—','No headlines right now');return;}
    var h='';
    arts.slice(0,8).forEach(function(a,i){
      var img=(a.images&&a.images[0]&&a.images[0].url)||'';
      var link=(a.links&&a.links.web&&a.links.web.href)||'#';
      var tm=a.published?timeAgo(a.published):'';
      var src=a.source||'ESPN';
      h+='<a class="news-card" href="'+link+'" target="_blank" rel="noopener" data-i="'+i+'">'
        +(img?'<img class="news-img" src="'+img+'" alt="" loading="lazy" onerror="this.style.display=\'none\'">':'')
        +'<div class="news-body"><div class="news-hl">'+(a.headline||a.title||'')+'</div>'
        +'<div class="news-meta">'+src+' \u00b7 '+tm+'</div></div></a>';
    });
    $('homeNews').innerHTML=h;
  } catch(e) {
    $('homeNews').innerHTML=errHTML('—','Headlines unavailable','Trying again shortly');
  }
}

// ===========================================================================
// REFRESH ENGINE
// ===========================================================================
async function refreshAll() {
  var btn=$('refreshBtn'); btn.classList.add('spinning');
  cdVal=120;

  await Promise.allSettled([
    loadWeather(), loadFire(),
    loadBoard('nba','nbaBoard','nbaCt'),
    loadBoard('ncaab','ncaabBoard','ncaabCt'),
    loadBoard('mlb','mlbBoard','mlbCt'),
    loadBoard('cbase','cbaseBoard','cbaseCt'),
    loadBoard('nfl','nflBoard','nflCt'),
    loadBoard('cfb','cfbBoard','cfbCt'),
    loadNews()
  ]);
  await loadFavs();
  loadWeeklyOutlook(); // fire and forget — don't block refresh
  loadNBAUpcoming(); // fire and forget — upcoming NBA games

  btn.classList.remove('spinning');
  var now=new Date();
  $('lastUpd').innerHTML='Updated '+now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
    +' \u00b7 <span class="countdown" id="cd">2:00</span>';
  $('hdrSub').textContent=userCity+' \u00b7 '+fmtDate(now);

  clearInterval(refreshTimer); clearInterval(cdTimer);
  cdVal=120;
  cdTimer=setInterval(function(){
    cdVal--;
    var el=$('cd');
    if(el)el.textContent=Math.floor(cdVal/60)+':'+String(cdVal%60).padStart(2,'0');
    if(cdVal<=0)clearInterval(cdTimer);
  },1000);
  refreshTimer=setTimeout(refreshAll,REFRESH_MS);
}

// ===========================================================================
// BOOT
// ===========================================================================
async function boot() {
  try {
    await initLocation();
    await Promise.allSettled([
      loadWeather(),
      loadFire(),
      loadBoard('nba','nbaBoard','nbaCt'),
      loadBoard('ncaab','ncaabBoard','ncaabCt'),
      loadBoard('mlb','mlbBoard','mlbCt'),
      loadBoard('cbase','cbaseBoard','cbaseCt'),
      loadBoard('nfl','nflBoard','nflCt'),
      loadBoard('cfb','cfbBoard','cfbCt'),
      loadNews()
    ]);
    await loadFavs();
    loadWeeklyOutlook();
    loadNBAUpcoming();
  } catch(e) {}
  dismissSplash();
  startAutoRefresh();
}

function dismissSplash() {
  var now = new Date();
  $('hdrSub').textContent = userCity + ' \u00b7 ' + fmtDate(now);
  $('lastUpd').innerHTML = 'Updated ' + now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})
    + ' \u00b7 <span class="countdown" id="cd">2:00</span>';
}

function startAutoRefresh() {
  cdVal = 120;
  cdTimer = setInterval(function(){
    cdVal--;
    var el = $('cd');
    if(el) el.textContent = Math.floor(cdVal/60) + ':' + String(cdVal%60).padStart(2,'0');
    if(cdVal <= 0) clearInterval(cdTimer);
  }, 1000);
  refreshTimer = setTimeout(refreshAll, REFRESH_MS);
}

// Service Worker Registration
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(function(){});
}

// Enter key for weather search
document.addEventListener('DOMContentLoaded',function(){
  $('wInput').addEventListener('keydown',function(e){if(e.key==='Enter')searchWeather();});
  boot();
});
