var ImageDB = {
    images: {},
    get: function (src) {
        return this.images[src] || null;
    },
    register: function (src, drawable) {
        this.images[src] = drawable;
    }
};

module.exports = { ImageDB };