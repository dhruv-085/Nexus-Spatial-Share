const fs = require('fs');
const file = 'src/lib/TransferEngine.ts';
let code = fs.readFileSync(file, 'utf8');

// 1. Remove the malformed updateAdaptiveWindow fragment starting from '}* 1.5;' down to '  }' before '  // ┌─── Sender: Public API'
const badFragmentStart = code.indexOf('}* 1.5;');
if (badFragmentStart !== -1) {
  const senderApiIdx = code.indexOf('Sender: Public API', badFragmentStart);
  if (senderApiIdx !== -1) {
     // find the '}' just before the Sender: Public API block
     let endIdx = code.lastIndexOf('}', senderApiIdx);
     if (endIdx !== -1) {
       code = code.substring(0, badFragmentStart + 1) + '\n\n' + code.substring(endIdx + 1);
       console.log('Removed malformed lines.');
     }
  }
}

// 2. Add tuneSocketBuffers if missing
if (!code.includes('private tuneSocketBuffers()')) {
  // Find where to insert it. Let's put it right before 'private growWindow()'
  let growWindowIdx = code.indexOf('private growWindow() {');
  if (growWindowIdx === -1) growWindowIdx = code.indexOf('private growWindow(): void {');
  
  if (growWindowIdx !== -1) {
     // Find the start of its JSDoc or the line before
     const commentStart = code.lastIndexOf('/**', growWindowIdx) !== -1 ? code.lastIndexOf('/**', growWindowIdx) : growWindowIdx;
     
     const tuneSocketBuffersCode = `  private tuneSocketBuffers() {
    for (const conn of this.connections) {
      if (conn?.dataChannel) {
        conn.dataChannel.bufferedAmountLowThreshold = BACKPRESSURE_LOW;
        conn.dataChannel.onbufferedamountlow = () => {
          if (this.backpressurePaused) {
            this.backpressurePaused = false;
            this.backpressurePausedSince = 0;
            this.pumpWindow();
          }
        };
      }
    }
  }\n\n`;
     
     code = code.substring(0, commentStart) + tuneSocketBuffersCode + code.substring(commentStart);
     console.log('Added tuneSocketBuffers code.');
  }
}

// 3. Clean up the weird comment line ending in /** that powershell printed as 'Buffer tuning ... /**'
code = code.replace(/.*Buffer tuning.*\/\*\*/g, '// Buffer tuning\n\n  /**'); 

fs.writeFileSync(file, code, 'utf8');
console.log('Done.');
