(() => {
  'use strict';
  const match = location.hash.match(/^#t=([A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{32})$/);
  location.replace(match ? `/trade/#tw=${match[1]}` : '/trade/');
})();
