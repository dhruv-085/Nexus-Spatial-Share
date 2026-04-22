const fs = require('fs');
const file = 'src/lib/TransferEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// The line is something like: //  Buffer tuning ...    private tuneSocketBuffers() {
// We can just find '    private tuneSocketBuffers() {' and ensure it's on a new line.

const badStr = '    private tuneSocketBuffers() {';
const idx = code.indexOf(badStr);
if (idx !== -1) {
    // If the previous character is not a newline, insert one
    if (code[idx - 1] !== '\n') {
       code = code.substring(0, idx) + '\n' + code.substring(idx);
       fs.writeFileSync(file, code, 'utf8');
       console.log('Fixed comment line missing newline.');
    } else {
       console.log('Newline already present?');
    }
}
