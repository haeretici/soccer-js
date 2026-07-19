const fs = require('fs');

const palettes = require('./palettes.json');
const teams = Object.keys(palettes);

const eliteTeams = new Set([
    'Argentina', 'Belgium', 'Brazil', 'England', 'France', 
    'Germany', 'Netherlands', 'Portugal', 'Spain', 'Uruguay', 'Croatia'
]);

const strongTeams = new Set([
    'Algeria', 'Australia', 'Austria', 'Colombia', "Côte d'Ivoire", 
    'Czechia', 'Ecuador', 'Egypt', 'Japan', 'Korea Republic', 
    'Mexico', 'Morocco', 'Norway', 'Senegal', 'Sweden', 
    'Switzerland', 'Türkiye', 'United States', 'IR Iran'
]);

function seedRandom(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return Math.abs(Math.sin(hash) * 1000) % 1;
}

function getBaseTier(teamName) {
    if (eliteTeams.has(teamName)) return { min: 78, max: 92, avg: 85 };
    if (strongTeams.has(teamName)) return { min: 70, max: 82, avg: 76 };
    return { min: 60, max: 72, avg: 66 };
}

const playerStatsPreset = {};

for (const team of teams) {
    const tier = getBaseTier(team);
    playerStatsPreset[team] = [];
    
    for (let jersey = 1; jersey <= 22; jersey++) {
        const seedStr = `${team}_${jersey}`;
        const rng = (offset = 0) => {
            return seedRandom(seedStr + '_' + offset);
        };
        
        let role = 'outfield';
        let speed = 65;
        let stamina = 70;
        let passing = 65;
        let dribbling = 65;
        let shooting = 60;
        let tackling = 60;
        let goalkeeping = 15;
        let accuracy = 65;
        
        if (jersey === 1 || jersey === 12) {
            role = 'GK';
            speed = 50 + rng(1) * 15;
            stamina = 60 + rng(2) * 20;
            passing = 55 + rng(3) * 20;
            dribbling = 35 + rng(4) * 20;
            shooting = 20 + rng(5) * 20;
            tackling = 30 + rng(6) * 25;
            goalkeeping = 80 + rng(7) * 15;
            accuracy = 50 + rng(8) * 20;
        } else if ((jersey >= 2 && jersey <= 5) || (jersey >= 13 && jersey <= 16)) {
            role = 'DF';
            speed = 55 + rng(1) * 25;
            stamina = 70 + rng(2) * 25;
            passing = 55 + rng(3) * 25;
            dribbling = 45 + rng(4) * 25;
            shooting = 30 + rng(5) * 25;
            tackling = 72 + rng(6) * 20;
            goalkeeping = 10 + rng(7) * 10;
            accuracy = 55 + rng(8) * 25;
        } else if ((jersey >= 6 && jersey <= 8) || (jersey >= 17 && jersey <= 20)) {
            role = 'MF';
            speed = 60 + rng(1) * 25;
            stamina = 75 + rng(2) * 20;
            passing = 72 + rng(3) * 20;
            dribbling = 65 + rng(4) * 25;
            shooting = 50 + rng(5) * 25;
            tackling = 55 + rng(6) * 25;
            goalkeeping = 10 + rng(7) * 10;
            accuracy = 68 + rng(8) * 20;
        } else {
            role = 'FW';
            speed = 75 + rng(1) * 20;
            stamina = 65 + rng(2) * 25;
            passing = 60 + rng(3) * 25;
            dribbling = 72 + rng(4) * 20;
            shooting = 74 + rng(5) * 20;
            tackling = 30 + rng(6) * 25;
            goalkeeping = 10 + rng(7) * 10;
            accuracy = 70 + rng(8) * 22;
        }
        
        const tierFactor = tier.avg / 75.0;
        const clamp = (val) => Math.max(10, Math.min(99, Math.round(val * tierFactor)));
        
        // Define player traits
        const traits = [];
        if (jersey === 9) {
            const r = rng(9);
            if (r < 0.5) traits.push('Selfish Finisher');
            else if (r < 0.85) traits.push('Speed Demon');
        } else if (jersey === 10) {
            const r = rng(10);
            if (r < 0.65) traits.push('Playmaker');
            else if (r < 0.85) traits.push('Selfish Finisher');
        } else if (jersey === 7 || jersey === 11) {
            const r = rng(11);
            if (r < 0.6) traits.push('Speed Demon');
            else if (r < 0.85) traits.push('Playmaker');
        } else if (jersey === 3 || jersey === 4) {
            const r = rng(4);
            if (r < 0.6) traits.push('Hard Tackler');
        } else {
            const r = rng(12);
            if (r < 0.1) {
                if (role === 'DF') traits.push('Hard Tackler');
                if (role === 'MF') traits.push('Playmaker');
                if (role === 'FW') traits.push('Speed Demon');
            }
        }
        // A.8: rare Poor Touch on lower-dribbling outfielders
        if (role !== 'GK' && dribbling < 58 && rng(20) < 0.22) {
            if (!traits.includes('Poor Touch')) traits.push('Poor Touch');
        }
        
        playerStatsPreset[team].push({
            jersey,
            role,
            speed: clamp(speed),
            stamina: clamp(stamina),
            passing: clamp(passing),
            dribbling: clamp(dribbling),
            shooting: clamp(shooting),
            tackling: clamp(tackling),
            goalkeeping: clamp(goalkeeping),
            accuracy: clamp(accuracy),
            traits
        });
    }
}

const outputJson = {
    default_stats: {
        speed: 60,
        stamina: 80,
        passing: 70,
        dribbling: 70,
        shooting: 65,
        tackling: 60,
        goalkeeping: 50,
        accuracy: 70
    },
    teams: playerStatsPreset
};

fs.writeFileSync(__dirname + '/player_stats.json', JSON.stringify(outputJson, null, 2));
console.log("Successfully generated player_stats.json with individual team stats and traits!");
