const fs = require('fs');
const path = require('path');

const flagsDir = path.resolve(__dirname, '../assets/flags');
if (!fs.existsSync(flagsDir)) {
    fs.mkdirSync(flagsDir, { recursive: true });
}

// Helper generators
const horiz3 = (c1, c2, c3) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="150" fill="${c1}"/>
  <rect y="150" width="750" height="150" fill="${c2}"/>
  <rect y="300" width="750" height="150" fill="${c3}"/>
</svg>`.trim();

const vert3 = (c1, c2, c3) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="250" height="450" fill="${c1}"/>
  <rect x="250" width="250" height="450" fill="${c2}"/>
  <rect x="500" width="250" height="450" fill="${c3}"/>
</svg>`.trim();

const cross = (bg, cr, out) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="450" fill="${bg}"/>
  ${out ? `<rect x="210" width="150" height="450" fill="${out}"/><rect y="150" width="750" height="150" fill="${out}"/>` : ''}
  <rect x="240" width="90" height="450" fill="${cr}"/>
  <rect y="180" width="750" height="90" fill="${cr}"/>
</svg>`.trim();

const solidCircle = (bg, col, r = 100) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="450" fill="${bg}"/>
  <circle cx="375" cy="225" r="${r}" fill="${col}"/>
</svg>`.trim();

const flags = {
  // Hosts
  "canada": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400">
  <rect width="200" height="400" fill="#FF0000"/>
  <rect x="200" width="400" height="400" fill="#FFFFFF"/>
  <rect x="600" width="200" height="400" fill="#FF0000"/>
  <!-- Simplified maple leaf shape -->
  <polygon points="400,100 420,150 450,140 435,180 470,210 420,210 400,280 380,210 330,210 365,180 350,140 380,150" fill="#FF0000"/>
</svg>`.trim(),

  "mexico": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 700 400" width="700" height="400">
  <rect width="233" height="400" fill="#006847"/>
  <rect x="233" width="234" height="400" fill="#FFFFFF"/>
  <rect x="467" width="233" height="400" fill="#CE1126"/>
  <!-- Eagle emblem placeholder -->
  <circle cx="350" cy="200" r="30" fill="#8B5A2B"/>
  <polygon points="350,160 360,180 340,180" fill="#FCD116"/>
</svg>`.trim(),

  "united states": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 400" width="760" height="400">
  <!-- 13 Stripes -->
  <rect width="760" height="30.7" fill="#B22234"/>
  <rect y="30.7" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="61.4" width="760" height="30.7" fill="#B22234"/>
  <rect y="92.1" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="122.8" width="760" height="30.7" fill="#B22234"/>
  <rect y="153.5" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="184.2" width="760" height="30.7" fill="#B22234"/>
  <rect y="214.9" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="245.6" width="760" height="30.7" fill="#B22234"/>
  <rect y="276.3" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="307" width="760" height="30.7" fill="#B22234"/>
  <rect y="337.7" width="760" height="30.7" fill="#FFFFFF"/>
  <rect y="368.4" width="760" height="31.6" fill="#B22234"/>
  <!-- Canton -->
  <rect width="304" height="214.9" fill="#3C3B6E"/>
  <circle cx="60" cy="50" r="4" fill="#FFFFFF"/>
  <circle cx="120" cy="50" r="4" fill="#FFFFFF"/>
  <circle cx="180" cy="50" r="4" fill="#FFFFFF"/>
  <circle cx="240" cy="50" r="4" fill="#FFFFFF"/>
  <circle cx="90" cy="100" r="4" fill="#FFFFFF"/>
  <circle cx="150" cy="100" r="4" fill="#FFFFFF"/>
  <circle cx="210" cy="100" r="4" fill="#FFFFFF"/>
  <circle cx="60" cy="150" r="4" fill="#FFFFFF"/>
  <circle cx="120" cy="150" r="4" fill="#FFFFFF"/>
  <circle cx="180" cy="150" r="4" fill="#FFFFFF"/>
  <circle cx="240" cy="150" r="4" fill="#FFFFFF"/>
</svg>`.trim(),

  // Brazil & Argentina & England & Germany (re-written locally for completeness)
  "brazil": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 504" width="720" height="504">
  <rect width="720" height="504" fill="#009c3b"/>
  <polygon points="360,40 680,252 360,464 40,252" fill="#ffdf00"/>
  <circle cx="360" cy="252" r="126" fill="#002776"/>
  <path d="M234,252 Q360,162 486,252" fill="none" stroke="#ffffff" stroke-width="16"/>
</svg>`.trim(),

  "argentina": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 480" width="720" height="480">
  <rect width="720" height="160" fill="#74acdf"/>
  <rect y="160" width="720" height="160" fill="#ffffff"/>
  <rect y="320" width="720" height="160" fill="#74acdf"/>
  <circle cx="360" cy="240" r="30" fill="#fcf3cf" stroke="#f39c12" stroke-width="4"/>
  <path d="M360,195 L360,285 M315,240 L405,240 M328,208 L392,272 M328,272 L392,208" stroke="#f39c12" stroke-width="4"/>
</svg>`.trim(),

  "germany": horiz3("#000000", "#dd0000", "#ffce00"),
  "england": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="450" fill="#ffffff"/>
  <rect x="330" width="90" height="450" fill="#ce1124"/>
  <rect y="180" width="750" height="90" fill="#ce1124"/>
</svg>`.trim(),

  // UEFA
  "austria": horiz3("#C8102E", "#FFFFFF", "#C8102E"),
  "belgium": vert3("#000000", "#FDDA24", "#EF3340"),
  "croatia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="150" fill="#FF0000"/>
  <rect y="150" width="750" height="150" fill="#FFFFFF"/>
  <rect y="300" width="750" height="150" fill="#171796"/>
  <!-- Croatian shield -->
  <rect x="350" y="175" width="50" height="50" fill="#FF0000" stroke="#FFFFFF" stroke-width="4"/>
</svg>`.trim(),

  "czechia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="225" fill="#FFFFFF"/>
  <rect y="225" width="750" height="225" fill="#D7141A"/>
  <polygon points="0,0 337.5,225 0,450" fill="#11457E"/>
</svg>`.trim(),

  "france": vert3("#002395", "#FFFFFF", "#ED2939"),
  "netherlands": horiz3("#AE1C28", "#FFFFFF", "#21468B"),
  "norway": cross("#BA0C2F", "#00205B", "#FFFFFF"),
  "portugal": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="300" height="450" fill="#006622"/>
  <rect x="300" width="450" height="450" fill="#FF0000"/>
  <circle cx="300" cy="225" r="50" fill="#FFCC00"/>
</svg>`.trim(),

  "scotland": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="450" fill="#0065BD"/>
  <path d="M0,0 L750,450 M750,0 L0,450" stroke="#FFFFFF" stroke-width="60"/>
</svg>`.trim(),

  "spain": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="112.5" fill="#C60B1E"/>
  <rect y="112.5" width="750" height="225" fill="#FCD116"/>
  <rect y="337.5" width="750" height="112.5" fill="#C60B1E"/>
  <!-- Simplified Pillars -->
  <rect x="150" y="160" width="15" height="100" fill="#C60B1E"/>
  <rect x="220" y="160" width="15" height="100" fill="#C60B1E"/>
</svg>`.trim(),

  "sweden": cross("#006AA7", "#FECC00"),
  "switzerland": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">
  <rect width="500" height="500" fill="#DA291C"/>
  <rect x="215" y="80" width="70" height="340" fill="#FFFFFF"/>
  <rect x="80" y="215" width="340" height="70" fill="#FFFFFF"/>
</svg>`.trim(),

  "türkiye": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#E30A17"/>
  <circle cx="300" cy="250" r="100" fill="#FFFFFF"/>
  <circle cx="325" cy="250" r="80" fill="#E30A17"/>
  <!-- Star -->
  <polygon points="410,250 435,265 425,235 440,215 405,215" fill="#FFFFFF"/>
</svg>`.trim(),

  "bosnia and herzegovina": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 375" width="750" height="375">
  <rect width="750" height="375" fill="#002F6C"/>
  <polygon points="187.5,0 562.5,0 562.5,375" fill="#FFCD00"/>
  <!-- Stars -->
  <circle cx="187.5" cy="50" r="8" fill="#FFFFFF"/>
  <circle cx="230" cy="100" r="8" fill="#FFFFFF"/>
  <circle cx="272.5" cy="150" r="8" fill="#FFFFFF"/>
  <circle cx="315" cy="200" r="8" fill="#FFFFFF"/>
  <circle cx="357.5" cy="250" r="8" fill="#FFFFFF"/>
  <circle cx="400" cy="300" r="8" fill="#FFFFFF"/>
</svg>`.trim(),

  // CONMEBOL
  "colombia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="225" fill="#FCD116"/>
  <rect y="225" width="750" height="112.5" fill="#003893"/>
  <rect y="337.5" width="750" height="112.5" fill="#CE1126"/>
</svg>`.trim(),

  "ecuador": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="225" fill="#FFDD00"/>
  <rect y="225" width="750" height="112.5" fill="#003087"/>
  <rect y="337.5" width="750" height="112.5" fill="#DA291C"/>
  <!-- Seal -->
  <circle cx="375" cy="225" r="25" fill="#8B5A2B"/>
</svg>`.trim(),

  "paraguay": horiz3("#D52B1E", "#FFFFFF", "#0038A8"),
  "uruguay": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <!-- 9 stripes -->
  <rect width="750" height="55.5" fill="#FFFFFF"/>
  <rect y="55.5" width="750" height="55.5" fill="#0081C6"/>
  <rect y="111" width="750" height="55.5" fill="#FFFFFF"/>
  <rect y="166.5" width="750" height="55.5" fill="#0081C6"/>
  <rect y="222" width="750" height="55.5" fill="#FFFFFF"/>
  <rect y="277.5" width="750" height="55.5" fill="#0081C6"/>
  <rect y="333" width="750" height="55.5" fill="#FFFFFF"/>
  <rect y="388.5" width="750" height="55.5" fill="#0081C6"/>
  <rect y="444" width="750" height="56" fill="#FFFFFF"/>
  <!-- Canton Sun -->
  <rect width="200" height="222" fill="#FFFFFF"/>
  <circle cx="100" cy="111" r="30" fill="#FFCC00"/>
</svg>`.trim(),

  // OFC
  "new zealand": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400">
  <rect width="800" height="400" fill="#00247D"/>
  <!-- Stars -->
  <polygon points="600,100 605,115 590,115 602,125 598,140 610,130" fill="#FF0000" stroke="#FFFFFF" stroke-width="2"/>
  <polygon points="650,200 655,215 640,215 652,225 648,240 660,230" fill="#FF0000" stroke="#FFFFFF" stroke-width="2"/>
  <polygon points="580,280 585,295 570,295 582,305 578,320 590,310" fill="#FF0000" stroke="#FFFFFF" stroke-width="2"/>
</svg>`.trim(),

  // Concacaf
  "curaçao": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#002B7F"/>
  <rect y="300" width="750" height="50" fill="#F9E814"/>
  <circle cx="120" cy="100" r="25" fill="#FFFFFF"/>
  <circle cx="200" cy="150" r="15" fill="#FFFFFF"/>
</svg>`.trim(),

  "haiti": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="225" fill="#00209F"/>
  <rect y="225" width="750" height="225" fill="#D21034"/>
  <rect x="300" y="175" width="150" height="100" fill="#FFFFFF"/>
</svg>`.trim(),

  "panama": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="375" height="250" fill="#FFFFFF"/>
  <rect x="375" width="375" height="250" fill="#072357"/>
  <rect y="250" width="375" height="250" fill="#DA121A"/>
  <rect x="375" y="250" width="375" height="250" fill="#FFFFFF"/>
  <circle cx="187.5" cy="125" r="30" fill="#072357"/>
  <circle cx="562.5" cy="375" r="30" fill="#DA121A"/>
</svg>`.trim(),

  // AFC
  "iraq": horiz3("#CE1126", "#FFFFFF", "#000000"),
  "ir iran": horiz3("#239B56", "#FFFFFF", "#DA291C"),
  "japan": solidCircle("#FFFFFF", "#BC002D", 90),
  "jordan": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 375" width="750" height="375">
  <rect width="750" height="125" fill="#000000"/>
  <rect y="125" width="750" height="125" fill="#FFFFFF"/>
  <rect y="250" width="750" height="125" fill="#007A3D"/>
  <polygon points="0,0 250,187.5 0,375" fill="#E30A17"/>
  <circle cx="80" cy="187.5" r="15" fill="#FFFFFF"/>
</svg>`.trim(),

  "korea republic": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#FFFFFF"/>
  <circle cx="375" cy="250" r="90" fill="#CD2E3A"/>
  <path d="M 375,160 A 45,45 0 0,1 375,250 A 45,45 0 0,0 375,340 A 90,90 0 0,1 375,160" fill="#0047A0"/>
</svg>`.trim(),

  "qatar": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 320" width="800" height="320">
  <rect width="800" height="320" fill="#8A1538"/>
  <polygon points="0,0 240,0 280,20 240,40 280,60 240,80 280,100 240,120 280,140 240,160 280,180 240,200 280,220 240,240 280,260 240,280 280,300 240,320 0,320" fill="#FFFFFF"/>
</svg>`.trim(),

  "saudi arabia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#006C35"/>
  <rect x="200" y="320" width="350" height="15" fill="#FFFFFF"/> <!-- sword -->
</svg>`.trim(),

  "uzbekistan": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 375" width="750" height="375">
  <rect width="750" height="120" fill="#0099B5"/>
  <rect y="120" width="750" height="10" fill="#CE1126"/>
  <rect y="130" width="750" height="115" fill="#FFFFFF"/>
  <rect y="245" width="750" height="10" fill="#CE1126"/>
  <rect y="255" width="750" height="120" fill="#1EB53A"/>
</svg>`.trim(),

  "australia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400" width="800" height="400">
  <rect width="800" height="400" fill="#00008B"/>
  <circle cx="600" cy="120" r="10" fill="#FFFFFF"/>
  <circle cx="680" cy="220" r="10" fill="#FFFFFF"/>
  <circle cx="580" cy="300" r="10" fill="#FFFFFF"/>
  <circle cx="620" cy="240" r="6" fill="#FFFFFF"/>
</svg>`.trim(),

  // CAF
  "algeria": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="375" height="500" fill="#006633"/>
  <rect x="375" width="375" height="500" fill="#FFFFFF"/>
  <path d="M 375,175 A 75,75 0 0,0 375,325 A 60,60 0 0,1 375,175" fill="#E30A17"/>
  <polygon points="385,235 400,250 385,265 395,250" fill="#E30A17"/>
</svg>`.trim(),

  "cabo verde": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="450" fill="#002A8F"/>
  <rect y="225" width="750" height="90" fill="#FFFFFF"/>
  <rect y="255" width="750" height="30" fill="#E30613"/>
  <circle cx="250" cy="270" r="50" fill="none" stroke="#FCD116" stroke-width="8" stroke-dasharray="15,10"/>
</svg>`.trim(),

  "congo dr": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600">
  <rect width="800" height="600" fill="#007FFF"/>
  <polygon points="0,600 800,0 800,80 80,600" fill="#CE1126"/>
  <polygon points="0,600 800,0 800,50 50,600" fill="#FCD116"/>
  <polygon points="80,100 100,150 150,150 110,180 130,230 80,200 30,230 50,180 10,150 60,150" fill="#FCD116"/>
</svg>`.trim(),

  "côte d'ivoire": vert3("#FF8200", "#FFFFFF", "#009E60"),
  "egypt": horiz3("#CE1126", "#FFFFFF", "#000000"),
  "ghana": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 450" width="750" height="450">
  <rect width="750" height="150" fill="#CE1126"/>
  <rect y="150" width="750" height="150" fill="#FCD116"/>
  <rect y="300" width="750" height="150" fill="#006B3F"/>
  <!-- Star -->
  <polygon points="375,190 390,235 430,235 400,260 415,305 375,280 335,305 350,260 320,235 360,235" fill="#000000"/>
</svg>`.trim(),

  "morocco": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#C1272D"/>
  <polygon points="375,160 395,225 460,225 410,260 430,325 375,290 320,325 340,260 290,225 355,225" fill="none" stroke="#006233" stroke-width="12"/>
</svg>`.trim(),

  "senegal": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="250" height="500" fill="#00853F"/>
  <rect x="250" width="250" height="500" fill="#FCD116"/>
  <rect x="500" width="250" height="500" fill="#C1272D"/>
  <polygon points="375,210 385,245 420,245 390,265 405,300 375,280 345,300 360,265 330,245 365,245" fill="#00853F"/>
</svg>`.trim(),

  "south africa": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#007A4D"/>
  <rect width="750" height="166" fill="#E30613"/>
  <rect y="334" width="750" height="166" fill="#002395"/>
  <polygon points="0,0 250,250 0,500" fill="#000000"/>
  <polygon points="0,0 220,250 0,500" fill="#FCD116" stroke="#FFFFFF" stroke-width="8"/>
</svg>`.trim(),

  "tunisia": `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 500" width="750" height="500">
  <rect width="750" height="500" fill="#E70013"/>
  <circle cx="375" cy="250" r="100" fill="#FFFFFF"/>
  <path d="M 375,185 A 65,65 0 0,0 375,315 A 50,50 0 0,1 375,185" fill="#E70013"/>
  <polygon points="390,230 405,245 390,260 400,245" fill="#E70013"/>
</svg>`.trim()
};

// Write all flag SVGs to assets/flags
for (const [name, code] of Object.entries(flags)) {
    const filename = `${name.replace(/\s+/g, '_')}.svg`;
    fs.writeFileSync(path.join(flagsDir, filename), code, 'utf8');
}

console.log("Successfully generated all 48 flags locally!");
