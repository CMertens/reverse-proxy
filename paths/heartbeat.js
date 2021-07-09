/***************************
Trivial example of an intercepted request.
***************************/

module.exports["/heartbeat"] = {
    "to":function(){
        // Example: return the results of a function rather than proxy the call
        return '{"ok":true}';
    },  
    "contentType":"application/json",
    "secure":false,
    "priority":1
};