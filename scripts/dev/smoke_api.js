require('dotenv').config();
const http = require('http');

const data = JSON.stringify({
    andGroups: [
        ["AI", "engineer"],
        ["inference", "optimization", "quantization", "model compression", "triton", "ONNX"],
        ["C++"]
    ],
    mustNot: ["CTO", "founder", "CEO"],
    locations: ["Tokyo"],
    limit: 25,
    minExp: undefined,
    maxExp: undefined
});

const options = {
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/search',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(process.env.API_USER + ':' + process.env.API_PASS).toString('base64'),
        'Content-Length': data.length
    }
};

const start = Date.now();
console.log("Sending request to backend...");

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Duration: ${Date.now() - start}ms`);
        if (res.statusCode !== 200) {
            console.log("Response:", body);
        } else {
            const json = JSON.parse(body);
            console.log(`Found ${json.total} total, ${json.hits.length} hits`);
        }
    });
});

req.on('error', (e) => {
    console.error(`Problem with request: ${e.message}`);
});

req.write(data);
req.end();
