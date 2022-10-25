const marked = require('marked');

function loader(source) {
    return marked.parse(source);
}

module.exports = loader;