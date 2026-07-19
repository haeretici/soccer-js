class Script {
    constructor() {
        this.parent = null;
        this.level = null;
        this.destroyFlag = false; // Initialize destroyFlag for clarity
    }

    start() {}

    async update() {}

    render(g) {}

    destroy() {
        if (!this.parent?.scripts) {
            console.warn('Cannot destroy: parent or scripts array is missing');
            return;
        }
        this.destroyFlag = true;
        const index = this.parent.scripts.findIndex(script => script === this);
        if (index !== -1) {
            this.parent.scripts.splice(index, 1);
        }
    }

    async onMessage(message) {}

    onGUI(g) {}
}

module.exports = { Script };
