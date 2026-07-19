const { Settings } = require('./kernel/settings.js');
const { PlayerStates, isGkProtected, grantGkPossession } = require('./kernel/core/entities/player.js');
const { Simulator, MatchStates } = require('./kernel/providers/simulator/simulator.js');
const { StateMachine } = require('./kernel/core/lib/fsm.js');

const { initGameApp } = require('./kernel/apps/game/app.js');
const { initTestsApp } = require('./kernel/apps/tests/app.js');
const { initBatchBuilderApp } = require('./kernel/apps/batch-builder.js');
const { initSimulationAnalysisApp } = require('./kernel/apps/simulation-analysis/app.js');
const { initAssetManagerApp } = require('./kernel/apps/asset-manager/app.js');

if (typeof window !== 'undefined') {
    window.__SOCCER_TEST_EXPORTS__ = {
        PlayerStates,
        Simulator,
        MatchStates,
        StateMachine,
        isGkProtected,
        grantGkPossession,
        ImageDB: require('./kernel/core/lib/imagedb.js').ImageDB,
        SpriteGenerator: require('./kernel/core/lib/sprite_generator.js').SpriteGenerator,
        SpriteManifest: require('./kernel/core/lib/sprite_manifest.js')
    };
}

document.addEventListener('DOMContentLoaded', () => {
    const bodyId = document.body ? document.body.id : '';
    
    if (bodyId === 'game-app') {
        initGameApp().catch(err => console.error('Error initializing Game app:', err));
    } else if (bodyId === 'tests-app') {
        initTestsApp().catch(err => console.error('Error initializing Tests app:', err));
    } else if (bodyId === 'batch-builder-app') {
        initBatchBuilderApp().catch(err => console.error('Error initializing Batch Builder app:', err));
    } else if (bodyId === 'simulation-analysis-app') {
        initSimulationAnalysisApp().catch(err => console.error('Error initializing Simulation Analysis app:', err));
    } else if (bodyId === 'asset-manager-app') {
        initAssetManagerApp().catch(err => console.error('Error initializing Asset Manager app:', err));
    }
});
