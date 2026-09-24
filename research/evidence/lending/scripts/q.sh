#!/bin/sh
# usage: q.sh outfile 'graphql query'
node -e '
const q=process.argv[1];fetch("https://api.morpho.org/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:q})}).then(r=>r.text()).then(t=>{require("fs").writeFileSync(process.argv[2],t);console.log(t.slice(0,+process.argv[3]||4000))})' "$2" "$1" "$3"
