const LOGIC_UPS = 20;
const LOGIC_DT = 1 / LOGIC_UPS;

var Time = {
    time: 0,
    timeSinceLevelLoad: 0,
    deltaTime: 0,
    base: 0,
    getFixedLogicDeltaTime() {
        return LOGIC_DT;
    },
    advanceFixedLogicStep() {
        this.deltaTime = this.getFixedLogicDeltaTime();
        this.time += this.deltaTime;
        this.timeSinceLevelLoad += this.deltaTime;
    },
    // DEPRECATED — unused; live play uses advanceFixedLogicStep()
    update: function () {
        this.deltaTime = (performance.now() - this.base) / 1000;
        this.base = performance.now();
        this.time += this.deltaTime;
        this.timeSinceLevelLoad += this.deltaTime;
    },
    resetTimeSinceLevelLoad: function () {
        this.base = performance.now();
        this.timeSinceLevelLoad = 0;
    }
};

module.exports = { Time, LOGIC_UPS, LOGIC_DT };
