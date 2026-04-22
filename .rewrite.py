import fs

app_path = "d:\\Projects\\Nexus Spatial Share\\Website Code\\nexus-spatial-share\\src\\App.tsx"

with open(app_path, "r", encoding="utf-8") as f:
    code = f.read()

# 1. Imports
code = code.replace("import Peer, { DataConnection } from \"peerjs\";\n", "")

# 2. Refs
code = code.replace("const peerRef = useRef<Peer | null>(null);", "const pcRef = useRef<RTCPeerConnection | null>(null);")
code = code.replace("const connRef = useRef<DataConnection[]>([]);", "const connRef = useRef<RTCDataChannel[]>([]);")
code = code.replace("const controlConnRef = useRef<DataConnection[]>([]);", "const controlConnRef = useRef<RTCDataChannel[]>([]);")

# 3. We'll use AST/Regex or just raw string splitting since we know exactly where things are
start_idx = code.find("  const initPeer = (myId: string, roomToJoin: string) => {")
end_idx = code.find("  const handleJoin = () => {")

if start_idx == -1 or end_idx == -1:
    print("Could not find blocks!")
    exit(1)

# Now we need the socket useEffect. It's from `useEffect(() => {\n    const socket = io();`
# to `return () => {\n      socket.disconnect();\n      if (peerRef.current)`
socket_start = code.find("  useEffect(() => {\n    const socket = io();")

with open("d:\\Projects\\Nexus Spatial Share\\Website Code\\nexus-spatial-share\\.rewrite.py", "w") as f:
    f.write("Will do surgical replace")
