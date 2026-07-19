var Orientation = {
    UP: 0,
    UP_RIGHT: 1,
    RIGHT: 2,
    DOWN_RIGHT: 3,
    DOWN: 4,
    DOWN_LEFT: 5,
    LEFT: 6,
    UP_LEFT: 7
};

class GameObject {
    constructor(name) {
        this.children = new Array();
        this.scripts = new Array();
        this.active = true;
        this.parent = null;
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.orientation = Orientation.RIGHT;
        this.name = typeof (name) != 'undefined' ? name : 'GameObject';
        this.globalX = 0;
        this.globalY = 0;
    }

    destroy() {
        this.active = false;
        if (this.parent == null) return;
        this.destroyFlag = true;
        for (var i in this.parent.children) {
            if (typeof (this.parent.children[i].destroyFlag) != 'undefined') {
                this.parent.children.splice(i, 1);
                break;
            }
        }
    }

    start() {}

    insertScript(script) {
        script.parent = this;
        script.level = this.getRoot();
        script.start();
        this.scripts.push(script);
    }

    insertChild(child) {
        child.parent = this;
        child.updateGlobalPos();
        child.start();
        this.children.push(child);
    }

    async onMessage(message) {};

    async sendMessage(message, receiver) {
        await receiver.onMessage(message);
    }

    async broadcastMessage(message) {
        await this.onMessage(message);
        for (var i in this.scripts) {
            await this.scripts[i].onMessage(message);
        }
        for (i = 0; i < this.children.length; i++) {
            await this.children[i].broadcastMessage(message);
        }
    }

    getRoot() {
        if (this.parent != null) {
            return this.parent.getRoot();
        } else {
            return this;
        }
    }

    async update() {}

    updateGlobalPos() {
        this.globalX = this.x;
        this.globalY = this.y;
        var parent = this.parent;
        while (parent) {
            this.globalX += parent.x;
            this.globalY += parent.y;
            parent = parent.parent;
        }
    }

    updateAll() {
        if (this.active) {
            this.updateGlobalPos();
            this.update();
            for (var i in this.scripts) {
                this.scripts[i].update();
            }
            for (var i in this.children) {
                this.children[i].updateAll();
            }
        }
    }

    render(g){}

    renderAll(g) {
        if (this.active) {
            this.render(g);
            for (var i in this.children) {
                this.children[i].renderAll(g);
            }
            for (var i in this.scripts) {
                this.scripts[i].render(g);
            }
        }
    }

    setPosition(x, y, z, orientation = Orientation.DOWN) {
        this.x = x;
        this.y = y;
        this.z = z;
        this.orientation = orientation;
    }

    onGUI(g){}

    onGUIAll(g) {
        if (this.active) {
            this.onGUI(g);
            for (var i in this.scripts) {
                this.scripts[i].onGUI(g);
            }
            for (var i in this.children) {
                this.children[i].onGUIAll(g);
            }
        }
    }
}

module.exports = { Orientation, GameObject };
