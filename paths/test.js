module.exports["/v1/api/test"] = {
    "to":"http://localhost:5555",
    "secure":false,
    "ignoreProxiedIP":true,
    "enableCors": true,
    "priority":1,
    "rewriteRequest":function(proxyReq, req, res, options){
      // Example: rewriting the target path 
      console.log("rewrite " + proxyReq.path);
      proxyReq.path = "/search?" + proxyReq.path.split('?')[1];
      console.log("rewrote " + proxyReq.path);
    },
    "rewriteResponse":function(proxyRes, req, res, options){
        console.log("Rewriting...");
        res.setHeader('x-test-header', 'hello world!');
    }
};