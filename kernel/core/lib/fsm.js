class StateMachine {
    constructor(owner) {
        this.owner = owner;
        this.currentState = null;
        this.previousState = null;
        // globalState notes
        // Not really used in this project
        // The owner object will have the common method (onMessage, common update)
        this.globalState = null;
    }

    setCurrentState(s) {
        this.currentState = s;
    }

    setGlobalState(s) {
        this.globalState = s;
    }

    setPreviousState(s) {
        this.previousState = s;
    }

    update() {
        // if a global state exists, call its execute method, else do nothing
        if (this.globalState !== null) {
            this.globalState.execute(this.owner);
        }

        // same for the current state
        if (this.currentState !== null) {
            this.currentState.execute(this.owner);
        }
    }

    changeState(pNewState, data = null) {
        // keep a record of the previous state
        this.previousState = this.currentState;

        // call the exit method of the existing state
        if (this.currentState !== null) {
            this.currentState.exit(this.owner);
        }

        // change state to the new state
        this.currentState = pNewState;

        // call the entry method of the new state (pass optional transition data for flexibility)
        if (this.currentState !== null) {
            this.currentState.enter(this.owner, data);
        }
    }

    revertToPreviousState(data = null) {
        this.changeState(this.previousState, data);
    }

    isInState(st) {
        return this.currentState !== null && this.currentState === st;
    }

    getCurrentState() {
        return this.currentState;
    }

    getGlobalState() {
        return this.globalState;
    }

    getPreviousState() {
        return this.previousState;
    }

    getNameOfCurrentState() {
        return this.currentState?.name || '';
    }
}

// StateBase Ref
/*
const StateBase = {
    enter: function(owner) {},
    execute: function(owner) {},
    exit: function(owner) {}
}
 */

module.exports = { StateMachine };