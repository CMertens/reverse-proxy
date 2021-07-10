/************************************************************************************

This is a simple, single-file reverse proxy with basic capabilities for proxying and serving content.
The proxy is SSL-secured and is capable of dispatching based on hostnames and URL paths, and supports 
CIDR allow-listing, request and response rewriting, CORS enablement, and local static and dynamic content 
serving. It is suitable for internal development needs, but should not be considered production-ready, as 
compared to options such as NGINX and HAProxy.

#Required Directories
./paths
./ssl
  ./ssl/certificate.pem
  ./ssl/key.pem
./responses

#Environment Variables
- PROXY_PORT: Port number to listen on.
- PROXY_MAX_CALLS_PER_SECOND: Global rate limit for API calls.
- PATH_FILE: Name of the "paths.json" file, as described below.

#path.json
A path.json file can define multiple paths. Each path uses a stringified regex value as the key, with 
an object containing configuration data about the path.

Each path object can take the following properties:
  - to: (String, String[], Function, must be a path import if a function is used) Required. 
    Where to proxy the request to. May be a string (servername or, if prefaced with 'file:', a local 
    filename), array of strings (servernames), or a function that should return a string.
  - priority: (Int) If included, indicates the relative priority of the path, where lower is higher-priority.
    If not included, the path is assumed to have the lowest possible priority, and will only be matched if
    it is the first match for the path.
  - hostnames: (String[]) An optional array of requested hostnames that must be matched (using the client
    host request header). If not present or a zero-length array, the host header will be ignored.
  - rewriteRequest: (Function, must be a path import) A function to rewrite the ProxyRequest object, 
    if needed. This may return a string, an value that implements the toString() method, or a Promise, which
    will be treated as a string or toString()able value.
  - rewriteResponse: (Function, must be a path import) A function to rewrite the proxied response. Note that
    currently this does not allow interception of the proxied response, so use of this function should be
    limited to header writing. Use "rewriteRequest" to intercept the request if you need to do more complex
    proxying logic.
  - secure: (Boolean) Whether the target is TLS-secured. False if not provided.
  - websocket: (Boolean) Whether the target is a websocket. False if not provided.
  - allowedCidrs: (String[]) A list of CIDRs to allow. If the array is empty, no one will be able to 
    access the endpoint. If allowedCidrs does not exist or is not an array, all requests will be serviced.
  - ignoreProxiedIP: (Boolean) If false or undefined, both the IP the request comes from and the content 
    of the X-Forwarded-For header will be checked against the allow-list (if allowedCidrs is populated). If 
    true, then the content of X-Forwarded-For will not be checked. The default is more restrictive (e.g., 
    both the request origin and the proxied orgin must be allowed.)
  - contentType: (String) If included, will override content-type for static files and return functions.
  - enableCors: (Boolean) Add CORS headers to the response (non-Websockets only).

# Path Module Exports
Path objects can also be defined in code by creating module exports in the ./paths directory. Simply 
add the path regex as a key to the "exports" object, with the value of a path object as described above, 
in any file in ./paths, and the proxy will auto-discover the new paths.

#Static Responses
If you wish to return custom HTML responses to various error codes generated by the proxy 
(e.g., 404, 502, etc.), simply add the HTML to the ./responses directory, with the filename in the format 
"{HTTP response code}.html."

************************************************************************************/

var https = require('https');
var url = require('url'); // necessary to get URL()
var httpProxy = require('http-proxy');
var wcmatch = require('wildcard-match');
var fs = require('fs');
var ip6addr = require('ip6addr');
var path = require('path');
var tls = require('tls');

const PORT = process.env.PROXY_PORT | 443;
const MAX_CALLS_PER_SECOND = process.env.PROXY_MAX_CALLS_PER_SECOND | 1000;

const PATH_FILE = "paths.json";
const SSL_DIR = './ssl';
const SSL_KEY_FILENAME = 'key.pem';
const SSL_CERT_FILENAME = 'certificate.pem'

const STATIC_RESPONSE_DIR = './responses';

var sslKeys = {};
var privateKey = fs.readFileSync(path.join(SSL_DIR, SSL_KEY_FILENAME));
var certificate = fs.readFileSync(path.join(SSL_DIR, SSL_CERT_FILENAME));
var tlsKeys = {key: privateKey, cert: certificate};

// Find any hostname-specific certificates
for(const fname of fs.readdirSync(SSL_DIR)){
  fs.stat(path.join(SSL_DIR, fname), (err, stats) => {
    if(!err){
      if(stats.isDirectory()){   
        sslKeys[fname.toLowerCase()]= undefined;
        let cred = tls.createSecureContext({
          key : fs.readFileSync(path.join(SSL_DIR, fname,  SSL_KEY_FILENAME), 'utf8'),
          cert : fs.readFileSync(path.join(SSL_DIR, fname, SSL_CERT_FILENAME), 'utf8')
        });
        sslKeys[fname] = cred;   
      }
    }
  });
}

tlsKeys.SNICallback = function(hostname, cb){
  let ckey = sslKeys[hostname.toLowerCase()];
  if(ckey != undefined){
    if(cb){
      cb(null, ckey);
    } else {
      return(ckey);
    }
  } else {
    cb();
  }
}

// Track calls and drain DDOS protection counter each second
var currentCalls = 0;
setInterval(() => {
  currentCalls = (currentCalls - MAX_CALLS_PER_SECOND) < 0 ? 0 :  (currentCalls - MAX_CALLS_PER_SECOND);
}, 1000);

var pathMaps = {};
console.log("Reading proxy mapping data from " + PATH_FILE);
try {
  let pathData = fs.readFileSync(PATH_FILE);
  if(pathData != undefined && pathData != null && pathData !== ""){
    pathMaps = JSON.parse(pathData);
  }
}catch(err){
  console.log("Could not load paths from " + PATH_FILE);
  console.log(err);
}

// Load any dynamic modules in the ./paths directory
console.log("Loading dynamic proxy mapping data");
var pathModules = fs.readdirSync('./paths');
for(let mod of pathModules){
  var exp = require('./' + path.join('paths', mod));
  for(let key in exp){
    console.log("Mapping " + key);
    pathMaps[key] = exp[key];
  }
}

// Create a list of known-good targets
var buildPathMatches = () =>{
  var m = [];
  for(let s of Object.keys(pathMaps)){
    console.log("Building match for " + s);
    m.push(wcmatch(s));
  }
  return m;
};

// Create a list of URL-to-server mappings
var buildTargets = () => {
  var lm = [];  // array of regexes to determine if a match exists
  for(let s in pathMaps){
    console.log("Building path for " + s + " to " + pathMaps[s].to);
    lm.push(wcmatch(s));
  }
  return (urlString, req) => {
    var myUrl = new URL("https://192.0.2.0" + urlString);
    var goodMatches = [];
    for(let m of lm){
      if(m(myUrl.pathname)){
        // check to see if it matches the hostname
        var t = pathMaps[m.pattern];
        if(t["hostnames"] == undefined || t["hostnames"].length < 1){
          // If no, or zero-length, hostnames entry, match this pattern
          goodMatches.push(pathMaps[m.pattern]);
        } else {
          // test hostnames          
          var reqHost = req.headers.host;
          if(reqHost != undefined){
            for(let hn of t["hostnames"]){
              if(hn.toLowerCase() == reqHost.toLowerCase()){
                goodMatches.push(pathMaps[m.pattern]);
              }
            }
          }
        } // end hostname check
      } // end if regex matches
    } // end iterate through maps

    // check goodMatches for highest-priority match
    var currPri = 999999;
    var bestMatch = undefined;
    for(let currMatch of goodMatches){
      if(bestMatch == undefined){
        bestMatch = currMatch;
      }
      if(currMatch["priority"] != undefined){
        if(currMatch["priority"] < currPri){
          currPri = currMatch["priority"];
          bestMatch = currMatch;
        }
      }
    } // end prioritization test
    return bestMatch;

  } // end URL test function
}


var buildStaticResponses = () => {
  var staticResponses = {};
  // Find any static error pages
  var files = fs.readdirSync(STATIC_RESPONSE_DIR);
  for(let file of files){
    var code = file.split('.')[0];
    var data = fs.readFileSync(path.join(STATIC_RESPONSE_DIR,file));
    staticResponses[code.toString()] = data;
  }
  return staticResponses;
}

var staticResponse = (res, code) => {
  if(staticResponses[code.toString()]){
    res.writeHead(code);
    res.write(staticResponses[code.toString()]);
    res.end();
    return true;
  }
  return false;
}

var staticResponses = buildStaticResponses();
var matches = buildPathMatches();
var getTargetUrl = buildTargets();

var proxy = httpProxy.createProxyServer();

proxy.on('error', function(err, req, res){
  console.log("Error!");
  console.log(err);
  if(!staticResponse(res, 502)){
    res.writeHead(502, {'Content-Type':'text/plain'});
    res.write('server error');
    res.end();
  }
  return;
});

proxy.on('proxyReq', function(proxyReq, req, res, options){
  proxyReq.setHeader('x-forwarded-for', req.connection.remoteAddress);
  proxyReq.setHeader('x-forwarded-host', req.headers.host);
  var localTgt = getTargetUrl(req.url, req);
  if(localTgt != undefined && localTgt["rewriteRequest"] != undefined && typeof(localTgt["rewriteRequest"]) == 'function'){
    localTgt.rewriteRequest(proxyReq, req, res, options);
  }
});

proxy.on('proxyRes', function(proxyRes, req, res, options){
  var localTgt = getTargetUrl(req.url, req);
  if(localTgt != undefined){
    enableCors(localTgt, req, res);
    if(localTgt["rewriteResponse"] != undefined && typeof(localTgt["rewriteResponse"]) == 'function'){
      localTgt.rewriteResponse(proxyRes, req, res, options);      
    }
  }
});

var wsProxy = httpProxy.createProxyServer({ws:true});

wsProxy.on('proxyReq', function(proxyReq, req, res, options){
  proxyReq.setHeader('x-forwarded-for', req.connection.remoteAddress);
  proxyReq.setHeader('x-forwarded-host', req.headers.host);
  var localTgt = getTargetUrl(req.url, req);
  if(localTgt != undefined){ 
    if(localTgt["rewriteRequest"] != undefined && typeof(localTgt["rewriteRequest"]) == 'function'){
      localTgt.rewriteRequest(proxyReq);
    }
    if(localTgt["rewriteResponse"] != undefined && typeof(localTgt["rewriteResponse"]) == 'function'){
      localTgt.rewriteResponse(proxyReq, req, res, options);
    }
  }
});

wsProxy.on('error', function(err, req, res){
  console.log("Error!");
  console.log(err);
  if(!staticResponse(res, 502)){
    res.writeHead(502, {'Content-Type':'text/plain'});
    res.write('server error');
    res.end();
  }
  return;
});

// Verify global rate-limiting is not being violated
function isViolatingDDOS(req, res){
  currentCalls++;
  if(currentCalls > MAX_CALLS_PER_SECOND){
    if(!staticResponse(res, 403)){
      res.writeHead(403, {'Content-Type':'text/plain'});
      res.write("Flood protection");
      res.end();
    }
    return true;
  }
  return false;
}

// Verify the path is globally allow-listed
function isDisallowed(req, res){
  var myUrl = new URL("https://192.0.2.0" + req.url);
  var disallowed = true;
  for(let m of matches){
    if(m(myUrl.pathname)){
      disallowed = false;
    }    
  }
  if(disallowed){
    console.log("BLOCKED: " + myUrl.pathname);
    if(!staticResponse(res, 404)){
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.write("not found");
      res.end();
    }
  }
  return disallowed;
}

// Make sure the path has a configured target
function isUnconfigured(req, res){
  var tgt = getTargetUrl(req.url, req);
  if(tgt === undefined || tgt === null){
    console.log("BLOCKED: " + req.url);
    if(!staticResponse(res, 403)){
      res.writeHead(403, {'Content-Type':'text/plain'});
      res.write("Path not configured");
      res.end();
    }
    return true;
  }
  return false;
}

// Verify IP listing
function isBannedIP(tgt, req, res){
  if(tgt["allowedCidrs"] != undefined && Array.isArray(tgt["allowedCidrs"])){
    if(tgt["allowedCidrs"].length < 1){
      return true;
    }
    try {
      var clientIp = ip6addr.parse(req.connection.remoteAddress);
      var proxiedIp = undefined;
      if(req.headers['x-forwarded-for'] != undefined){
        proxiedIp = ip6addr.parse(req.headers['x-forwarded-for']);
      }
      for(let ip of tgt.allowedCidrs){
        var allowed = ip6addr.createCIDR(ip);
        if(allowed.contains(clientIp)){
          if(tgt["ignoreProxiedIP"] != undefined && tgt["ignoreProxiedIP"] == true){
            return false;
          } else if(proxiedIp != undefined && allowed.contains(proxiedIp)){            
            return false;
          } else {
            return true;
          }
        }
        return true;
      }
    } catch(err){
      // TODO log error here
      console.log("IP access error!");
      console.log(err);
      return true;
    }
    return true;
  }
  return false;
}

function enableCors(tgt, req, res) {
  if(tgt["enableCors"] == undefined || tgt["enableCors"] == false){
    return;
  }
	if (req.headers['access-control-request-method']) {
		res.setHeader('access-control-allow-methods', req.headers['access-control-request-method']);
	}

	if (req.headers['access-control-request-headers']) {
		res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers']);
	}

	if (req.headers.origin) {
		res.setHeader('access-control-allow-origin', req.headers.origin);
		res.setHeader('access-control-allow-credentials', 'true');
	}
}


var httpServer = https.createServer(tlsKeys, function(req, res){  
  var modifiers = undefined;
  if(isViolatingDDOS(req, res) || isDisallowed(req, res)){
    return;
  }  
  var tgt = getTargetUrl(req.url, req);    
  if(tgt == undefined){
    console.log("BLOCKED");
    if(!staticResponse(res, 404)){
      res.writeHead(404, {'Content-Type':'text/plain'});
      res.write('not found');
      res.end();
    }
    return;
  }
  var routeTo = undefined;
  
  if(typeof(tgt.to) === typeof(function(){})){
    let ct = "text/plain";
    if(tgt["contentType"] != undefined){
      ct = tgt["contentType"];
    }
    
    var resp = tgt.to(req, res);
    if(resp["then"] == undefined || resp["then"] != Promise.prototype.then){
      res.writeHead(200, {'Content-Type':ct});
      res.write(resp.toString());
      res.end();
    } else {
      // TODO: Promise handling is pretty fragile here -- handle error conditions
      (async function(){
        var innerResult = await resp;
        res.writeHead(200, {'Content-Type':ct});
        res.write(innerResult.toString());
        res.end();
      })();
      
    }
    return;
  }

  if(typeof(tgt.to) === typeof("")){
    routeTo = tgt.to;
    if(routeTo.startsWith('file:')){
      try {
        var data = fs.readFileSync(routeTo.substring(5));
        let ct = "text/plain";
        if(tgt["contentType"] != undefined){
          ct = tgt["contentType"];
        }
        res.writeHead(200, {'Content-Type':ct});
        res.write(data);
        res.end();
        return;
      }catch(err){
        console.log("FILE READ ERROR");
        console.log(err);
        if(!staticResponse(res, 404)){
          res.writeHead(404, {'Content-Type':'text/plain'});
          res.write("file not found");
          res.end();
        }
        return;
      }
    }
  }

  if(Array.isArray(tgt.to)){
    routeTo = tgt.to[Math.floor(Math.random() * tgt.to.length)];
    console.log(routeTo);
  }

  if(routeTo === undefined){
    if(!staticResponse(res, 403)){
      res.writeHead(403, {'Content-Type':'text/plain'});
      res.write("Path incorrectly configured");
      res.end();
    }
    return;
  }

  if(isBannedIP(tgt, req, res)){
    console.log("IP banned");
    console.log(req.connection.remoteAddress);
    if(!staticResponse(res, 403)){
      res.writeHead(403, {'Content-Type':'text/plain'});
      res.write("ip banned");
      res.end();
    }
    return;
  }  
    console.log("FORWARDING: " + req.url + " to " + routeTo);
    try {
      proxy.web(req, res, {target: routeTo, secure: (tgt.secure ? tgt.secure:false)});
    } catch(err){
      console.log("Error!");
      console.log(err);
      if(!staticResponse(res, 502)){
        res.writeHead(502, {'Content-Type':'text/plain'});
        res.write('server error');
        res.end();
      }
      return;
    }
});

// Handle websocket proxying
httpServer.on('upgrade', function(req, socket, head){
  try {
    var tgt = getTargetUrl(req.url, req);  
    if(tgt == undefined){
      console.log("STREAM UPGRADE BLOCKED");
      return;
    }
    var routeTo = tgt.to;
    if(isBannedIP(tgt, req)){      
      return;
    }

    if(tgt["websocket"] != undefined && tgt["websocket"] === true && typeof(tgt.to) === typeof("")){
      try {
        wsProxy.ws(req, socket, head, {target: routeTo, secure: (tgt.secure ? tgt.secure : false)});
      } catch(err){
        console.log("Error!");
        console.log(err);        
        return;
      }
    }    
  } catch(err){
    console.log("Error!");
    console.log(err);
    console.log(req.url);
  }
})

console.log("Starting proxy on port " + PORT);
httpServer.listen(PORT);
