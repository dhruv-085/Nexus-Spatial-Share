const fs = require('fs');
const file = 'src/lib/TransferEngine.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(/this\.adaptiveWindow\.currentSize/g, 'this.currentWindowSize');
code = code.replace(/this\.adaptiveWindow\.lastMeasureTime/g, 'this.lastMeasureTime');
code = code.replace(/this\.adaptiveWindow\.lastAckedBytes/g, 'this.lastAckedBytes');

fs.writeFileSync(file, code, 'utf8');
