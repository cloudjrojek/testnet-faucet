var express = require("express");
var cors = require("cors");
var bodyParser = require("body-parser");
var http = require("http");
var redis = require("redis");
var Promise = require("promise");
var bitcoin = require("bitcoin");
var btcmath = require("bitcoin-math");

var config = require("./config");

// set constants
var port = config.port;
var wait_time = config.wait_time; // time in seconds until app refreshes ip limits

// config redis
var redis_c = redis.createClient();
redis_c.on("error", function(err) {
  console.log("Error: " + err);
});

// config bitcoin
var btc_c = new bitcoin.Client({
  host: 'localhost',
  port: config.bvaultd.port,
  user: config.bvaultd.username,
  pass: config.bvaultd.password,
  timeout: 30000
});

// config app
var app = express();
app.set('port', port);
app.use(cors());
app.use(bodyParser.json()); // supports JSON encoded bodies
app.use(bodyParser.urlencoded({ // supports URL-encoded bodies
  extended: true
}));

// app will only respond with JSON
app.use(function(req, res, next) {
  res.header('Content-Type', 'application/json');
  next();
});

// hard cap limit of 1 000 000 satoshi or 2% of total balance
function getMaxWithdrawal () {
  var HARD_CAP_LIMIT = 1000000;
  var PERCENTAGE_OF_BAL = .02;
  var promise = new Promise(function(resolve, reject) {
    btc_c.getBalance('*', 1, function(err, balance, resHeaders) {
      if (err) {
        console.log(err);
        reject(err);
      }
      console.log('balance: ' + balance);
      resolve(Math.min(Math.floor(balance.toSatoshi() * PERCENTAGE_OF_BAL), HARD_CAP_LIMIT));
    });
})
  return promise;
}

// returns limit for IP from redis
function getSavedLimit (ip) {
  var promise = new Promise(function(resolve, reject) {
    redis_c.get(ip, function(err, result) {
      // we could connect to redis and make the query
      if (!err) {
        // this IP has visited before, return previously computed limits
        if (result && result != "0") {
          resolve(result);
        } else { 
          // set the limit and return it
            getMaxWithdrawal().then(function(max) {
            redis_c.set(ip, max);
            redis_c.expire(ip, wait_time);
            resolve(max);
          }, function(err) {
            reject(err);
          });
        }
      } else {
        reject(err);
      }
    });
  });
  return promise;
}

app.get('/', function(req, res) {
  // prefernce goes to x-forwarded-for in case behind proxy
  var ip = req.headers['x-forwarded-for'] || req.ip;
  getSavedLimit(ip).then(function(limit) {
    var resp = {
      ip: ip, 
      limit: limit
    }
    // if limit returns -1, we need to set the limit
    return res.end(JSON.stringify(resp));
  });
});

app.post('/', function(req, res) {
  var addr = req.body.address;
  var sat = parseInt(req.body.amount);
  var ip = req.headers['x-forwarded-for'] || req.ip;

  if (!addr || !sat) {
    res.statusCode = 406;
    console.log(ip + ": ERROR missing params");
    console.log(req.body);
    return res.end(JSON.stringify({
      error: "Missing required parameters"
    }));
  }

  // check IP limits
  getSavedLimit(ip).then(function(resp) {
    if (resp > sat) {
      // make transaction
      btc_c.cmd("sendtoaddress", addr, sat.toBitcoin(), function(err, txid, headers) {
        if (err) {
          res.statusCode = 422;
          console.log(ip + ": ERROR " + err.message);
          return res.end(JSON.stringify({
            code: err.code,
            error: err.message
          }));
        }

        // we have successfully made a txn
        // update limit, and send new limit and txid 
        redis_c.decrby(ip, sat, function(err, result) {
          if (err) {
            // this should never happen
            console.log(ip + ": INTERNAL ERROR");
            res.statusCode = 400;
            return res.end(JSON.stringify({
              error: "Internal Error"
            }));
          }

          console.log(ip + ": " + sat.toBitcoin() + " in txid " + txid);

          if (req.body.verbose) {
            btc_c.cmd("getrawtransaction", txid, 1, function(error, txn) {
              return res.end(JSON.stringify({
                id: txid,
                limit: result,
                txn: txn
              }));
            });
          } else {
            return res.end(JSON.stringify({
              id: txid,
              limit: result
            }));
          }

        });

      });
    } else {
      res.statusCode = 403;
      console.log(ip + ": ERROR request exceeds lim. " + sat + " > " + resp);
      return res.end(JSON.stringify({
        error: "Request exceeds limit",
        limit: resp,
        request: sat,
        ip: ip
      }));
    }
  })
});

// relays raw transaction
app.post('/sendraw', function(req, res) {
  var hex = req.body.hex;
  btc_c.cmd("sendrawtransaction", hex, function(err, txid, headers) {
    if (err) {
      res.statusCode = 422;
      console.log(ip + ": ERROR " + err.message);
      return res.end(JSON.stringify({
        code: err.code,
        error: err.message
      }));
    }
    return res.end(JSON.stringify({
      id: txid
    }));
  });
});

http.createServer(app).listen(app.get('port'), function() {
  console.log("Express server listening on port " + app.get('port'));
});
