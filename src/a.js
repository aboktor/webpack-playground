import ac from './ac';
import ab from './ab';
import ab2 from './ab2';
import abc from './abc';
import abcd from './abcd';
import onlya from './onlya'
import aAndMain from './aAndMain';
import markdown from './hello.md';
export default function a() {
    console.log('a');
    ab();
    ab2();
    ac();
    abc();
    abcd();
    onlya();
    aAndMain();
    const html = document.createElement('div');
    html.innerHTML = markdown;
    document.body.appendChild(html);
}